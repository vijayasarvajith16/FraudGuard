#!/bin/bash
# Wraps the official entrypoint: replica-set members authenticate to each other with a
# keyfile, which mongod requires whenever --replSet and authentication are combined.
# A single-node set only needs one per container start, so generate it here.
set -euo pipefail
openssl rand -base64 756 > /tmp/mongo-keyfile
chmod 400 /tmp/mongo-keyfile
chown mongodb:mongodb /tmp/mongo-keyfile
exec docker-entrypoint.sh "$@"
