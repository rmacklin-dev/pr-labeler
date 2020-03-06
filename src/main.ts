import * as core from '@actions/core';
import * as github from '@actions/github';
import * as yaml from 'js-yaml';
import {Minimatch} from 'minimatch';

function getTeamLabel(
  labelsConfiguration: Map<string, string[]>,
  author: string
): string[] {
  const labels: string[] = []
  for (const [label, authors] of labelsConfiguration.entries())
    if (authors.includes(author)) labels.push(label)
  return labels
}

function getPrAuthor(): string {
  const pullRequest = github.context.payload.pull_request
  if (!pullRequest) {
    return 'unknown'
  }

  return pullRequest.user.login
}

async function run() {
  try {
    const token = core.getInput('repo-token', {required: true});
    const configPath = core.getInput('configuration-path', {required: true});

    const prNumber = getPrNumber();
    if (!prNumber) {
      console.log('Could not get pull request number from context, exiting');
      return;
    }

    const client = new github.GitHub(token);

    core.debug(`fetching configuration from ${configPath}`);
    // loads (hopefully) a `{[label:string]: string | string[]}`, but is `any`:
    const configObject: any = await getConfigurationContents(client, configPath);

    core.debug(`fetching changed files for pr #${prNumber}`);
    const changedFiles: string[] = await getChangedFiles(client, prNumber);
    const labelGlobs: Map<string, string[]> = await getLabelGlobs(configObject);

    var teamLabelsToMembers: Map<string, string[]>;
    if (configObject.teams_configuration_location) {
      core.debug(`fetching teams from ${JSON.stringify(configObject.teams_configuration_location)}`);

      const externalRepoToken = core.getInput('external-repo-token');
      const externalRepoClient = externalRepoToken ? new github.GitHub(externalRepoToken) : client

      const response: any = await externalRepoClient.repos.getContents({
        ref: 'master',
        ...configObject.teams_configuration_location
      });

      const teamsData = JSON.parse(Buffer.from(response.data.content, response.data.encoding).toString());

      teamLabelsToMembers = new Map(
        Object.entries(teamsData).map(
          ([teamName, teamData]) => {
            if ((<any>teamData).members) {
              const { members, short } = <any>teamData;
              const teamLabel = short || teamName;

              const teamGitHubUsernames = Object.values(members).map(member => (<any>member).github);

              return [teamLabel, teamGitHubUsernames];
            } else {
              throw new Error('unexpected team data format (expected an object mapping team names to team metadata');
            }

          }
        )
      )
    } else {
      teamLabelsToMembers = new Map(Object.entries(configObject.team_labels));
    }

    const labels: string[] = [];
    for (const [label, globs] of labelGlobs.entries()) {
      core.debug(`processing ${label}`);
      if (checkGlobs(changedFiles, globs)) {
        labels.push(label);
      }
    }

    const additionalLabels = getTeamLabel(teamLabelsToMembers, getPrAuthor());
    additionalLabels.forEach(l => labels.push(l));

    const shouldCloseAndReopenIssue = additionalLabels.length > 0;
    if (shouldCloseAndReopenIssue) {
      await client.pulls.update({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: prNumber,
        state: 'closed'
      });
    }

    if (labels.length > 0) {
      await addLabels(client, prNumber, labels);
    }

    if (shouldCloseAndReopenIssue) {
      await client.pulls.update({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: prNumber,
        state: 'open'
      });
    }
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

function getPrNumber(): number | undefined {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return undefined;
  }

  return pullRequest.number;
}

async function getChangedFiles(
  client: github.GitHub,
  prNumber: number
): Promise<string[]> {
  const listFilesResponse = await client.pulls.listFiles({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  });

  const changedFiles = listFilesResponse.data.map(f => f.filename);

  core.debug('found changed files:');
  for (const file of changedFiles) {
    core.debug('  ' + file);
  }

  return changedFiles;
}

async function getConfigurationContents(
  client: github.GitHub,
  configurationPath: string
): Promise<any> {
  const configurationContent: string = await fetchContent(
    client,
    configurationPath
  );

  return yaml.safeLoad(configurationContent);
}

async function getLabelGlobs(
  configObject: any
): Promise<Map<string, string[]>> {
  // transform `any` => `Map<string,string[]>` or throw if yaml is malformed:
  return getLabelGlobMapFromObject(configObject.file_pattern_labels);
}

async function fetchContent(
  client: github.GitHub,
  repoPath: string
): Promise<string> {
  const response: any = await client.repos.getContents({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: repoPath,
    ref: github.context.sha
  });

  return Buffer.from(response.data.content, response.data.encoding).toString();
}

function getLabelGlobMapFromObject(configObject: any): Map<string, string[]> {
  const labelGlobs: Map<string, string[]> = new Map();
  for (const label in configObject) {
    if (typeof configObject[label] === 'string') {
      labelGlobs.set(label, [configObject[label]]);
    } else if (configObject[label] instanceof Array) {
      labelGlobs.set(label, configObject[label]);
    } else {
      throw Error(
        `found unexpected type for label ${label} (should be string or array of globs)`
      );
    }
  }

  return labelGlobs;
}

function checkGlobs(changedFiles: string[], globs: string[]): boolean {
  for (const glob of globs) {
    core.debug(` checking pattern ${glob}`);
    const matcher = new Minimatch(glob);
    for (const changedFile of changedFiles) {
      core.debug(` - ${changedFile}`);
      if (matcher.match(changedFile)) {
        core.debug(` ${changedFile} matches`);
        return true;
      }
    }
  }
  return false;
}

async function addLabels(
  client: github.GitHub,
  prNumber: number,
  labels: string[]
) {
  await client.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
    labels: labels.map(l => l.replace(/#/g, ''))
  });
}

run();
