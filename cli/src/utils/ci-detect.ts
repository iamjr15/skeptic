/** Detect CI environment, AI agent environment, and interactivity. */

export interface EnvironmentInfo {
  /** True when running in a known CI provider. */
  isCI: boolean;
  /** Name of the detected CI provider, if any. */
  ciProvider: string | null;
  /** True when running inside an AI coding agent. */
  isAgentEnv: boolean;
  /** Name of the detected agent, if any. */
  agentName: string | null;
  /** True when stdin is a TTY (interactive terminal). */
  isInteractive: boolean;
}


const CI_VARS: Record<string, string> = {
  GITHUB_ACTIONS: "GitHub Actions",
  GITLAB_CI: "GitLab CI",
  CIRCLECI: "CircleCI",
  JENKINS_URL: "Jenkins",
  TRAVIS: "Travis CI",
  BUILDKITE: "Buildkite",
  CODEBUILD_BUILD_ID: "AWS CodeBuild",
  TF_BUILD: "Azure Pipelines",
  BITBUCKET_PIPELINE_UUID: "Bitbucket Pipelines",
  DRONE: "Drone CI",
  SEMAPHORE: "Semaphore",
  TEAMCITY_VERSION: "TeamCity",
  VERCEL: "Vercel",
  NETLIFY: "Netlify",
  RENDER: "Render",
};

const AGENT_VARS: Record<string, string> = {
  CLAUDECODE: "Claude Code",
  CURSOR_AGENT: "Cursor",
  CODEX_CI: "Codex",
  OPENCODE: "OpenCode",
  AMP_HOME: "Amp",
};

export function detectCI(): EnvironmentInfo {
  const ciProvider = findCI();
  const isCI =
    ciProvider !== null ||
    process.env["CI"] === "true" ||
    process.env["CI"] === "1";

  const agentName = findAgent();
  const isAgentEnv = agentName !== null;

  return {
    isCI,
    ciProvider,
    isAgentEnv,
    agentName,
    isInteractive: !isCI && !isAgentEnv && Boolean(process.stdin.isTTY),
  };
}

function findCI(): string | null {
  for (const [envVar, name] of Object.entries(CI_VARS)) {
    if (process.env[envVar]) return name;
  }
  return null;
}

function findAgent(): string | null {
  for (const [envVar, name] of Object.entries(AGENT_VARS)) {
    if (process.env[envVar]) return name;
  }
  return null;
}
