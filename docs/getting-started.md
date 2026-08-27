# Getting started

There are three points at which Mochi Forge becomes useful, and each is a small step from the one before. Running a vault on your own machine takes two commands and answers the question of whether you want any of this. Putting one on the internet, where other people can reach it, is one more command and a Fly.io account. Giving it a domain of your own is DNS work, and worth doing once the vault is something you intend to keep.

This document walks the first two in full and hands the third to [Deploying a vault](deploying.md), which is the reference for everything about a hosted vault.

## 1. A vault on your own machine

A vault is a directory, and the server is one Node process pointed at it. Nothing else is installed, and nothing is written outside that directory, so the whole experiment is undone by deleting it. You need Node 20 or newer and git.

```bash
mkdir myvault
npx @magland/mochi serve myvault
```

Finding no `vault.json` in the directory, the server initializes one and prints an owner token:

```
Initialized a new vault (no vault.json found).
Owner token for user 'owner' (shown once; only its hash is stored):

  mochi_a86e77f29b4715949d27949ea576fbdccdf4b391979af150226e35b481f27868

Sign in on the web with it, or manage users from anywhere:
  mochi login http://127.0.0.1:3000

Mochi Forge serving vault /home/you/myvault
  http://127.0.0.1:3000
```

Copy that token somewhere before the terminal scrolls; only its hash is stored, so it cannot be shown again. If you lose it on a local vault the cheapest fix is to delete the directory and start over.

Open http://127.0.0.1:3000. The vault is empty, and reading it needs no credential, which is the same for every visitor: reads are anonymous and writes are not. To become the owner rather than a visitor, open `/login` and sign in as `owner` with the token in the **Token** field. A vault has no passwords, so a username and a token is what the form asks for.

### Put a repository in it

From any git repository you already have:

```bash
cd ~/some/project
git push http://127.0.0.1:3000/alice/myproject main
```

git asks for a username and a password: give `owner` and the token. The push creates the repository, and the collection `alice` holding it, because pushing to a path that does not exist yet creates it when you may create there; the owner may create anywhere. Reload the page and the repository is there, with its files, its history, and its README rendered.

Repositories are grouped into collections, so `alice` above could as well be `research` or `tools`; a collection is a name and a directory, not an account. What is now on disk is exactly:

```
myvault/
  vault.json                    (users and hashed tokens)
  collections/
    alice/
      repos/
        myproject.git/          (a bare repository, clonable and pushable)
```

### What to try from here

The interface is deliberately GitHub-shaped, so most of it needs no instructions. The parts worth going to look for:

- **Editing in the browser.** Open a file and edit it, or add one; the commit is authored as you and lands on the branch you were reading.
- **Issues and pull requests.** Both are stored as markdown files in the vault, beside the repository. Open an issue, then look in `myvault/collections/alice/repos/myproject.issues/` to see it as a file.
- **A static site.** Create `myvault/collections/alice/repos/myproject.site/` and put an `index.html` in it, then enable the site in the Site box of the repository's settings page. A Site tab appears in the repository's navigation, serving it at `/alice/myproject/site/`. See [Sites](sites.md).
- **The command line.** `mochi login http://127.0.0.1:3000` hands the same token to the CLI, after which `mochi repo list`, `mochi issue list`, and the rest work against this vault (see [The command line](cli.md)).

Two things behave differently on a laptop vault, and are worth knowing about rather than debugging: [workflows](workflows.md) do nothing until a runner is started separately with Docker, and other machines cannot reach the server, because it binds `127.0.0.1` unless told otherwise. `--host 0.0.0.0` opens it to your network, which is reasonable on a trusted network and not on the open internet, since tokens travel as Basic-auth passwords over plain HTTP.

Stop the server with Ctrl-C, and start it again with the same command; the vault is whatever is in the directory. To throw the experiment away, delete the directory.

If you would rather see a populated vault than build one, clone this repository and run `npm install && npm run example && npm run dev`, which creates `example-root/` with sample collections, repositories, issues, and a user `dev` whose token is `mochi_example_dev_token`.

## 2. A vault on the internet

The step from a laptop vault to a real one is a persistent disk and TLS in front, and `mochi deploy fly` arranges both. Fly.io runs the container; you need an account there, [flyctl](https://fly.io/docs/flyctl/install/) installed, and `fly auth login` run once. Nothing is needed on your machine but the CLI, and no checkout of this repository:

```bash
npm install -g @magland/mochi
fly auth login
mochi deploy fly my-vault-name
```

Fly app names are globally unique and the name becomes the URL, so pick your own. That creates the app, a 10GB volume, and a single machine serving the vault over HTTPS at `https://my-vault-name.fly.dev`, and ends by printing the owner token once. Save it: it is minted on your machine and only its hash reaches the server.

Then log in, from your own machine, and create the users:

```bash
mochi login https://my-vault-name.fly.dev    # asks for the token, without echo
mochi user add alice
```

`mochi user add` prints that user's token, which is what you hand them; it is the credential for both `git push` and signing in on the web. Users do not register themselves. A new user owns the collection named after them, `alice/` here, and nothing else, which is what most people should have; `mochi collab add` and `mochi collection owner add` grant more where it applies, and `--site-admin` is what delegates running the vault. The same work can be done in the browser, if you would rather see it.

What you now have is a vault anyone can read and only your users can write, at a URL you can send to someone. `mochi deploy fly my-vault-name` again deploys an update, `mochi deploy fly show my-vault-name` says what is running, and the disk, the machine size, and LFS objects in a bucket are flags on the deploy. All of that, and the costs and limits of running one machine against one volume, is in [Deploying a vault](deploying.md).

Two things about a hosted vault are worth being deliberate about. It is readable by anyone who finds the URL, since reads are anonymous by design, so put in it what you are content for a stranger to read, and mark a repository private (at creation or in its settings) when you are not. And the vault directory, `/vault` on the volume, is the entire state: a backup is a copy of that directory, and `mochi backup ~/backups/myvault` makes one over HTTP without a shell on the machine ([Backing up a vault](backup.md)). There is nothing else to arrange.

## 3. A domain of your own

`my-vault-name.fly.dev` is a real HTTPS URL and there is nothing wrong with keeping it. A domain of your own is worth the DNS work for two reasons: the vault's URL stops naming the host it happens to run on, which is what makes it possible to move later without breaking everyone's remotes, and static sites can be given a hostname each.

That second one is the substantive change. By default a repository's site is served from the vault's own hostname and sandboxed, which costs it cookies, storage, and service workers. Pointed at a wildcard hostname you control, each site gets a real origin of its own and those work normally. The trade-off is a wildcard certificate, which needs a DNS-01 challenge and therefore a record you add by hand.

Both, with the exact records and commands, are in [A domain of your own](deploying.md#a-domain-of-your-own). The sandbox and what it does and does not isolate are in [Sites](sites.md).

## Where to go next

- [The vault](vault.md): the layout on disk, and how signing in relates to the tokens git uses
- [The command line](cli.md): the `mochi` command, roles and tokens, importing existing repositories, and the JSON API
- [Deploying a vault](deploying.md): Fly.io in detail, a domain of your own, Docker and Caddy on a machine of your own, and the built-in limits
- [Workflows](workflows.md): GitHub Actions workflows, and the runner that executes them
