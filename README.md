# Hermes coding agent starter

This template runs [Hermes Agent](https://github.com/NousResearch/hermes-agent)
by [Nous Research](https://nousresearch.com/) as a coding agent on
[Dockhold](https://dockhold.eu), with your own model key from any provider
Hermes supports. You put a label on a GitHub issue in one repository; the
agent works on the issue and opens a pull request with its change. You
review and merge.

Hermes Agent is open source under the MIT license. This template installs
it unmodified from its release tag when the image is built. The template is
Dockhold's, not Nous Research's.

[![Deploy on Dockhold](https://dockhold.eu/button.svg)](https://app.dockhold.eu/new?repo=https://github.com/dockhold/hermes-coding-agent-starter&name=hermes-coding-agent-starter&ref=button-hermes-coding)

## Deploy

1. Make two keys first.
   * **Model key.** An API key from the provider whose model you want,
     for this app alone, so you can see its spend and revoke it on its own.
     [OpenRouter](https://openrouter.ai/) gives one key for models from many
     providers. Set a spend limit on the key at the provider if it offers one.
   * **GitHub token.** On GitHub, open Settings, Developer settings,
     Personal access tokens, Fine-grained tokens, and generate a new token.
     Under **Repository access** pick **Only select repositories** and choose
     the one repository the agent works on. Under **Permissions** set
     **Contents**, **Issues** and **Pull requests** to **Read and write**.
     **Metadata** is read-only and added on its own; the app uses it to
     check that an issue's author has write access.
2. Open the [Deploy link](https://app.dockhold.eu/new?repo=https://github.com/dockhold/hermes-coding-agent-starter&name=hermes-coding-agent-starter&ref=button-hermes-coding)
   and sign in if asked.
3. Under **App size**, pick **1 GB**. Under **App storage**, turn it on and
   pick **10 GB**. This app needs a paid size (see Costs). Under
   **Visibility**, pick **Private**: the agent only calls out to GitHub and
   your model provider, so nothing needs to reach it, and its status page
   stays yours. If you don't see **Visibility** yet, make the app private on
   its **Access** tab once it is deployed.
4. Under **Environment**, in the **Secrets** list, click **New secret** for
   each value, tick it, and set its **Env var name** as below. Give the
   entries names that belong to this app, for example
   `hermes-coding-agent-model-key`, because secrets are shared across your
   apps by name and two apps that share an entry would share a key.

   | Secret (your name) | Env var name | Value |
   | --- | --- | --- |
   | `hermes-coding-agent-model-key` | `AGENT_API_KEY` | Your model key |
   | `hermes-coding-agent-github-token` | `GITHUB_TOKEN` | The fine-grained GitHub token |
   | `hermes-coding-agent-dockhold-token` (optional) | `DOCKHOLD_API_TOKEN` | A Dockhold API token, see Security |

5. Add plain variables: `AGENT_REPO` with the repository as `owner/name`,
   for example `octo-org/website`, and `AGENT_MODEL` with the model as your
   provider names it. If your key is not from OpenRouter, also set
   `AGENT_PROVIDER` (see Model providers). The other variables are optional;
   see Settings.
6. Click **Deploy** and wait until the app shows as running. Open the app's
   address: a status page shows the repository, the label and the next poll.
   A private app asks you to sign in first: create a token on the app's
   **Access** tab and paste it into the password field.
7. **First task.** In the repository on GitHub, create a label named `agent`
   (Issues, Labels, New label). Open an issue that describes one change, and
   add the label. Within 10 minutes the agent picks it up, removes the label,
   and works on it. Follow it on the app's **Activity** tab. When it is done,
   a pull request is open and the issue has a comment with its link.

If the app refuses to start, its page shows one line saying what is missing.
App storage is on the app's **Size** tab; secrets are attached on its
**Variables** tab and their values are edited under **Secrets** in the
dashboard sidebar. Fix it and click **Restart**.

## Model providers

Set `AGENT_PROVIDER` to the provider your key is from, and `AGENT_MODEL` to
a model name as that provider writes it.

| Your key is from | `AGENT_PROVIDER` | `AGENT_MODEL`, for example |
| --- | --- | --- |
| OpenRouter | `openrouter` (the default) | `anthropic/claude-sonnet-4.6` |
| Anthropic | `anthropic` | `claude-sonnet-4-6` |
| Google AI Studio | `gemini` | `gemini-2.5-pro` |
| DeepSeek | `deepseek` | `deepseek-v4-pro` |
| xAI | `xai` | `grok-4` |
| OpenAI, or any OpenAI-compatible endpoint | `custom`, plus `AGENT_BASE_URL` | the endpoint's model name |

For `custom`, set `AGENT_BASE_URL` to the endpoint's `https://` address,
for example `https://api.openai.com/v1`. Every provider this Hermes release
takes an API key for is in [agent/providers.json](agent/providers.json),
with its aliases. Providers that sign in through a browser (such as Nous
Portal or GitHub Copilot) or through a cloud account (such as AWS Bedrock)
are not offered: an app that runs unattended cannot sign in.

## How it works

1. Every `AGENT_POLL_MINUTES` the app lists the open issues in `AGENT_REPO`
   that carry `AGENT_LABEL`, oldest first. It skips pull requests, issues
   it already finished, and issues whose author has no write access to the
   repository (write, maintain or admin; the owner always has it).
2. It claims the oldest one by removing the label.
3. It fetches the repository's default branch into App storage, resets the
   checkout to it, and creates the branch `agent/issue-<number>`. The
   agent's home folder is emptied and gets a fresh Hermes configuration, so
   every task starts clean: no memory, skills or settings carry over from
   the last one.
4. It runs Hermes once on the checkout (`hermes chat` with the prompt on
   standard input). The prompt is the issue's title and body; comments are
   not read. An `AGENTS.md` at the repository root is added after the issue,
   marked as the repository's own instructions. Nothing else Hermes would
   pick up from a checkout is loaded: no `.hermes.md`, `CLAUDE.md`,
   `.cursorrules` or `AGENTS.md` in a subfolder, no plugins, MCP servers or
   hooks from the checkout's `.hermes/` folder, no `.env`. The only MCP
   server the agent can have is Dockhold's, when you set the token. When the
   run ends, the app stops every process the run left, Hermes's own
   background process included, before it commits and pushes.
5. The agent uses the Hermes toolsets in `AGENT_TOOLSETS`: by default files,
   the terminal and a to-do list. Hermes refuses commands on its list of
   dangerous ones, since nobody is there to approve them, and the agent
   carries on without them.
6. When the agent is done, the app commits every change as one commit named
   after the issue, pushes it to `agent/issue-<number>`, and opens a pull
   request to the default branch with the agent's summary, `Closes #<number>`,
   the model and the tokens used. If that branch already has an open pull
   request, it is updated instead. The issue gets a comment with the link.
7. If the agent changed nothing, the issue gets a comment with its summary.
   If the run failed, the issue gets a comment with the reason, and the label
   stays off: add it again to retry.

One task runs at a time. When one finishes, the app polls again at once.
If the app is stopped in the middle of a task (a restart or a redeploy), it
stops the agent, puts the label back on the issue, and the task runs again
after the start. If the app stopped without warning (a crash, or running
out of memory), the label goes back at the next start. After 3 runs of the
same issue cut short that way, the app leaves the label off and comments on
the issue instead; add the label again to retry. Until a label is back,
the app claims no other issue. An issue that already got a pull request or
a "no changes" comment is not picked up again, even with the label back;
open a new issue for more work.

The branch `agent/issue-<number>` belongs to the agent: a new run for the
same issue replaces it. The app never pushes any other branch, and never the
default branch.

The status page at the app's address shows the repository, the label, the
current task, the last task and its result, the next poll and the last poll
error. `GET /health` answers `{"status":"ok"}`.

## Settings

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `AGENT_API_KEY` | Secret | (required) | Your model key. The agent's model use is billed to it. |
| `GITHUB_TOKEN` | Secret | (required) | Fine-grained token for one repository: Contents, Issues and Pull requests read and write. |
| `DOCKHOLD_API_TOKEN` | Secret | (none) | Optional. Gives the agent the Dockhold MCP server. See Security. |
| `AGENT_REPO` | Variable | (required) | The repository, as `owner/name`. |
| `AGENT_MODEL` | Variable | (required) | The model, as your provider names it. |
| `AGENT_PROVIDER` | Variable | `openrouter` | The provider your key is from. See Model providers. |
| `AGENT_BASE_URL` | Variable | (none) | Only with `AGENT_PROVIDER` `custom`: the endpoint's `https://` address. |
| `AGENT_LABEL` | Variable | `agent` | The label that hands an issue to the agent. |
| `AGENT_POLL_MINUTES` | Variable | `10` | Minutes between polls, 1 to 1440. |
| `AGENT_TOOLSETS` | Variable | `file,terminal,todo` | Hermes toolsets the agent may use, comma-separated. Leave out `terminal` and the agent cannot run commands. |
| `AGENT_MAX_TURNS` | Variable | `90` | Most tool-calling steps per task, 1 to 500. |
| `AGENT_TASK_MINUTES` | Variable | `60` | Wall-clock cap per task, 1 to 1440. Hermes is told to wrap up near the end and is stopped when it runs out. |

Variables are set on the app's **Variables** tab; change one and click
**Restart**. Dockhold sets `PORT` and `DATA_DIR` itself. Do not add them.

## Security

**An agent does what an issue says.** On a public repository anyone can open
an issue, so an issue runs only when its author has write access to the
repository (write, maintain or admin). Anyone else's issue is skipped with
one line in the log.
Issue comments are never read. The agent also reads your repository's files,
and text in them can steer it, so review every pull request it opens the way
you would review a stranger's.

**One repository, one token, and the agent never sees it.** The GitHub token
is fine-grained and limited to one repository. It stays in the app's own
program: the agent's environment is a fixed list that does not include it,
git gets it as a request header for one command at a time, and it is never
written to disk or put in a URL. The program and git run so that the
agent's processes cannot read their memory or environment, and anything the
agent leaves running is stopped before git uses the token. The app only
pushes `agent/issue-<number>` branches. It cannot merge; you do.

**The agent can read your model key**, and the Dockhold token when you set
one. It needs the key to work, and anything it runs (your tests, your
build, a package install) runs with the same access, with internet access.
Use a key for this app alone and revoke it if in doubt. The app refuses to
push a change that contains one of its secret values. That check matches
only the exact value or its base64 form, so treat it as a guard against
accidents, not against a determined agent. With `terminal` in
`AGENT_TOOLSETS` the agent runs commands; take it out to narrow what it can
do.

**The Dockhold token is optional.** Without it the agent has no Dockhold
tools. With it, the agent gets the Dockhold MCP server and can use it with
the token's permissions, on every app in your account, not only this one.
Create it under **API tokens** in the dashboard sidebar as **Read & deploy**,
and leave **Also allow writing secrets** off. Such a token lets the agent:

* list your apps and read their status, logs and resource use;
* list the names of your secrets and which apps they are attached to (never
  their values);
* deploy any repository your account's GitHub connection can see as a new
  app, private repositories included;
* redeploy and restart apps, and set or remove variables on any of them,
  which changes how other apps are configured;
* resize apps and databases, and add or remove an app's storage (removing
  erases its files).

It cannot write secrets or read their values. If the agent only needs to
look, a **Read-only** token is enough.

**What runs is what this repository holds.** An app deployed from this
template is built from this repository, and **Build again** on the app page
rebuilds it from the latest commit here. Since the app holds your keys, to
control exactly what code runs, make your own copy with **Use this
template** and deploy from that.

**Keep the app private.** The status page shows the repository name, issue
titles, pull request links and errors, never a key or token. On a public app
anyone with its address can read them. Pick **Private** when you deploy, or
switch it on the app's **Access** tab.

## Costs

* This app needs a paid size: 1 GB is two 512 MB units, $10 a month. See
  [pricing](https://dockhold.eu/pricing).
* You pay your model provider directly for the agent's model use, with your
  own key. Dockhold never pays for it, resells it or adds to it.
* Hermes reports tokens, not money, since the price depends on the provider
  and the model. Each pull request and issue comment shows the model and the
  tokens used. Each task stops at `AGENT_MAX_TURNS` steps or
  `AGENT_TASK_MINUTES`, whichever comes first. For a hard cap on spend, set
  a limit on the key at your provider.

**Why 1 GB.** Between tasks the app uses about 20 MB. During a task Hermes
uses up to about 460 MB: the command the app starts, and the background
process Hermes runs the agent in, which the app stops when the task ends.
The rest is for what the agent runs in your repository: package installs,
builds, tests. That part depends on your
repository. If a task runs out of memory, raise the size on the app's
**Size** tab.

## State and backups

App storage holds the checkout (`repo/`), the agent's home folder (`home/`)
and the task log (`tasks.jsonl`, one line per task: issue, time, outcome,
pull request, tokens). App storage is not backed up. If it is lost, the app
fetches the repository again and starts a new task log. The pull requests
and the issue comments on GitHub are the durable record of what the agent
did.

## Limitations

* One task at a time. Other labelled issues wait until it finishes.
* GitHub issues only, one repository per app. For a second repository,
  deploy a second app with its own token.
* Each poll reads the oldest 100 labelled issues.
* Each task starts with an empty Hermes home, so Hermes's memory and the
  skills it learns do not carry from one task to the next. Put what every
  task should know in `AGENTS.md`.
* There is no terminal into the app. You follow it on the app's **Activity**
  tab (one line per step, tool names only), in the pull requests and in the
  issue comments. The agent's full transcript is not kept.
* The agent cannot ask you a question during a task. Write what it needs in
  the issue.
* Commits are authored `Hermes coding agent <hermes-coding-agent@localhost>`.
  Branch rules that require signed commits refuse the push.
* One running copy while App storage is attached.

## Upgrading

The `Dockerfile` pins one Hermes Agent release (`HERMES_REF`), and this
repository moves that pin when a newer release has passed its tests. A
weekly check (`.github/workflows/upstream.yml`) opens an issue here when a
newer Hermes release is out. See [CHANGELOG.md](CHANGELOG.md).

* **Build again** on the app page rebuilds the app from the latest commit
  of this repository, the Hermes pin included. That is the plain way to
  move to this template's latest.
* **Restart** only restarts the version that is running.
* To control exactly what runs (the app holds your keys), click **Use this
  template** on GitHub to make your own copy, connect that repository in
  Dockhold and deploy from it. You then move the pin yourself: change
  `HERMES_REF` and push. The checks (`.github/workflows/check.yml`) build
  the image and run the tests, including one that fails if the new release
  no longer accepts an option this template passes.

The build also compares Hermes's list of API-key providers with
`agent/providers.json` and stops if they differ, so a new or renamed
provider shows up in review. To regenerate the file after an upgrade:

```bash
docker build --target hermes -t hermes-providers .
docker run --rm -v "$PWD/agent/providers.py:/providers.py:ro" --entrypoint python3 hermes-providers -I /providers.py > agent/providers.json
```

## License

This template's glue (Dockerfile, start script, the program in `agent/`,
tests, workflows, README) is MIT licensed, see [LICENSE](LICENSE). Hermes
Agent is Nous Research's software, MIT licensed
([license](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)).
It is not in this repository: it is installed from its release tag when the
image is built.
