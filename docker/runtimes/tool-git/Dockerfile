# Throw-away container for "git sync" and archive extraction: official git image plus Alpine security updates.
ARG BASE_IMAGE=alpine/git:v2.54.0
FROM ${BASE_IMAGE}
RUN apk upgrade --no-cache
