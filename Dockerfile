# Hermes coding agent starter for Dockhold.
#
# Runs Hermes Agent by Nous Research headless with your own model key, on
# GitHub issues that carry a label. Hermes Agent is MIT-licensed software by
# Nous Research, installed here unmodified at build time from its release
# tag. This repo holds only the glue: a start script and a small Node program
# with no npm dependencies.
#
# Upgrading Hermes: change HERMES_REF to a newer release tag. The weekly
# upstream check opens an issue when there is one. The build fails if the
# installed CLI does not report the pinned release.
#
# Upgrading Node: change NODE_VERSION and NODE_SHA256 together. The sha256 is
# the node-v<version>-linux-x64.tar.gz line of SHASUMS256.txt on
# https://nodejs.org/dist/v<version>/. A wrong or stale sha256 fails the
# build. That is the point.

# Hermes needs SQLite 3.51.3 or newer for its session store; Bookworm ships
# 3.40.1. Build the pinned release here and copy the one library file over.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS sqlite
ARG SQLITE_AUTOCONF_VERSION=3530400
ARG SQLITE_SHA256=0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl \
 && curl -fsSL -o /tmp/sqlite.tar.gz "https://sqlite.org/2026/sqlite-autoconf-${SQLITE_AUTOCONF_VERSION}.tar.gz" \
 && echo "${SQLITE_SHA256}  /tmp/sqlite.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/sqlite.tar.gz -C /tmp \
 && cd "/tmp/sqlite-autoconf-${SQLITE_AUTOCONF_VERSION}" \
 && CFLAGS="-O2 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_FTS4 -DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS3_PARENTHESIS \
      -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_UNLOCK_NOTIFY \
      -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_SECURE_DELETE \
      -DSQLITE_THREADSAFE=1 -DSQLITE_MAX_VARIABLE_NUMBER=250000" \
    ./configure --prefix=/opt/sqlite --disable-static \
 && make -j"$(nproc)" \
 && make install

FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim@sha256:7cf77f594be8042dab6daa9fe326f90962252268b4f120a7f5dccce4d947e6c1 AS hermes
ARG NODE_VERSION=22.23.4
ARG NODE_SHA256=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
ARG HERMES_REF=v0.22.6

COPY --from=sqlite /opt/sqlite/lib/libsqlite3.so.3.53.4 /usr/local/lib/

# One step, so every file lands in the image once, with its final mode:
#
# * git for the checkout, ca-certificates for HTTPS, tini as the main
#   process: it reaps every process the agent leaves behind once the app has
#   killed it, and passes the stop signal on to the app.
# * Node 22, the official release, checked against the pinned sha256. It
#   runs this starter's program and nothing else.
# * The processes that hold your GitHub token are tini (it starts with the
#   app's environment), node (this starter's program) and git (fetch and
#   push). All three are made executable but not readable for user 1001.
#   Linux marks a process started from a binary its user cannot read as not
#   dumpable, which hides that process's environment and memory
#   (/proc/<pid>/environ, /proc/<pid>/mem) from every other process of the
#   same user, the agent included. Running them is unaffected. Changing a
#   mode in a later step would store a second copy of the file, so it
#   happens here.
RUN ln -sf libsqlite3.so.3.53.4 /usr/local/lib/libsqlite3.so.0 \
 && ldconfig \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini curl \
 && curl -fsSL -o /tmp/node.tar.gz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE \
      --exclude='include' --exclude='lib/node_modules' --exclude='bin/npm' --exclude='bin/npx' --exclude='bin/corepack' \
      --exclude='share' \
 && rm /tmp/node.tar.gz \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/* \
 && node --version | grep -Fx "v${NODE_VERSION}" \
 && chmod 0711 /usr/bin/tini /usr/local/bin/node /usr/bin/git \
 && find /usr/lib/git-core -maxdepth 1 -type f -perm -u+x -exec chmod 0711 {} +

# Hermes Agent from its release tag, with the exact dependency versions of
# upstream's lock file (uv.lock), the way upstream's own image installs it,
# into /opt/hermes-venv. The mcp extra is the Dockhold MCP server's client;
# anthropic is the native SDK for Anthropic models. Other providers speak
# the OpenAI-compatible protocol through a core dependency. The project
# itself installs editable, which is how upstream's setup.py wants a source
# install. Upstream's install stamp records the release, and the
# install-method stamp marks the install as an image, so Hermes never tries
# to update itself. The build stops if SQLite is older than Hermes needs or
# the CLI does not report the pinned release.
ENV UV_PROJECT_ENVIRONMENT=/opt/hermes-venv \
    UV_PYTHON_DOWNLOADS=never \
    PATH=/opt/hermes-venv/bin:$PATH
RUN git clone --quiet --depth 1 --branch "${HERMES_REF}" https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
 && cd /opt/hermes-agent \
 && uv sync --frozen --no-dev --no-cache --extra mcp --extra anthropic \
 && python3 -I scripts/write_install_stamp.py --output install-stamp.json \
      --base-version "${HERMES_REF#v}" --distance 0 \
      --source ci --distribution docker --update-mechanism external \
 && printf 'docker\n' > .install_method \
 && rm -rf .git web ui-tui website tests tests-js apps docker nix assets evals \
 && python3 -I -c "import sqlite3, sys; sys.exit(0 if sqlite3.sqlite_version_info >= (3, 51, 3) else 'SQLite ' + sqlite3.sqlite_version + ' is too old for Hermes')" \
 && hermes --version | head -n 1 | grep -F "v${HERMES_REF#v} "

# The app: this starter's program on top of Hermes.
FROM hermes
COPY agent /app/agent
COPY entrypoint.sh /app/entrypoint.sh
# agent/providers.json is the list of model providers the program accepts.
# It is generated from Hermes itself and kept in the repository so a change
# shows up in review: the build fails when this Hermes release's list
# differs. After an upgrade, regenerate it with the command in the README.
RUN chmod 0755 /app/entrypoint.sh /app/agent \
 && chmod 0644 /app/agent/*.mjs /app/agent/*.py /app/agent/providers.json \
 && python3 -I /app/agent/providers.py | diff -u /app/agent/providers.json - \
 || { echo "agent/providers.json differs from this Hermes release's providers (diff above)"; exit 1; }

USER 1001:1001
# tini is process 1. The start script execs the program, so tini's one child
# is the program itself and the stop signal reaches it directly.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
