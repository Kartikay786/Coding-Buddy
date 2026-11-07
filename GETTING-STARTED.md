# ReviewRoom: Getting started (for people who received this folder)

ReviewRoom checks a code branch before it is merged: it summarises the change, scans it for security problems,
runs your tests, and only merges when a **human has approved** and every check passes.
You can use it alone in a terminal (Part 1, 5 minutes) or with AI agents in a team chat (Part 2, optional).

## You need
- Node.js 18 or newer (https://nodejs.org) and Git (https://git-scm.com)
- Nothing else for Part 1. No account, no internet service, no cost.

## Part 1: Use the tool on your own project

**Step 1. Install (once).** Open a terminal in the folder that contains the `reviewroom` folder and run:

    npm install -g ./reviewroom
    reviewroom help

If you see "file already exists", an older copy is installed: run `npm uninstall -g reviewroom`, then install again.
If `reviewroom` is "not found", close and reopen the terminal.

**Step 2. Try it on a practice project (2 minutes).**

    reviewroom demo ./demo-repo
    cd demo-repo
    reviewroom scan feature/user-search
    reviewroom test feature/user-search
    reviewroom approve feature/user-search --by YourName
    reviewroom gate feature/user-search --merge

You should see a security finding, a failed test, and **BLOCKED**. That is the tool protecting `main`.

**Step 3. Use it on your real project (once per project).**

    cd your-project            (must be a git repo with a main branch)
    reviewroom init

Open the new `.reviewroom.json` and set:
- `base`: your main branch name (usually `main`)
- `testSetup`: runs before tests, for example `npm ci` (leave empty if none)
- `testCommand`: how your tests run, for example `npm test` or `pytest`

**Step 4. Review a branch (every time).**

    git fetch
    reviewroom summary  feature/my-branch      what changed, and how risky
    reviewroom scan     feature/my-branch      security findings with file and line
    reviewroom test     feature/my-branch      runs your tests in a clean copy
    reviewroom approve  feature/my-branch --by YourName
    reviewroom gate     feature/my-branch --merge
    git push origin main                       merging happens locally, so push yourself

`gate` merges only if: the scan ran on the latest commit, no HIGH findings are open, tests passed on the latest
commit, and a human approved the latest commit. A new commit voids the old approval and test result.
Useful extras: `reviewroom waive` (a human accepts a finding, with a reason), `reviewroom decisions` (the log),
`reviewroom report <branch>` (a markdown report).

## Part 2 (optional): AI agents in a team chat with Switch

One person sets this up; teammates just type in their chat app.
1. Install Switch Console (https://github.com/sandbox-quantum/switch/releases/latest) and start a local server.
2. Install an agent CLI and sign in (OpenCode has free models).
3. Connect a chat app (Telegram needs a free bot from @BotFather; the built-in chat needs Docker).
4. Open `review-agents.template.yaml`, change every `directory:` line to your repo path, then in Console:
   Templates, Import template, Save, Use, Create all. (Telegram bots cannot create groups: make the group yourself,
   add your bot as admin, then add the four agents to that room in Console or ask switch-buddy. If your chat app
   lets Switch create rooms, `review-room.template.yaml` makes the room too; set its `bridge:` to your app's name.)
5. In the chat type: `review feature/my-branch`, then `approve feature/my-branch` when you are happy.

## Good to know
- The scanner finds common patterns (injection, secrets, weak crypto and similar). It does not replace a human reviewer.
- Anyone can type `--by <name>`; the tool blocks agent-looking names but cannot prove who a person is.
- Works on any language: only `testCommand` changes. Tested on Windows and Linux.
- Problems? Run `npm test` inside the `reviewroom` folder (7 tests should pass) and send the output to the author.
