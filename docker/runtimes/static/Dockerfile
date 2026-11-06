# Static website runtime: the official unprivileged nginx plus current Alpine security updates.
ARG BASE_IMAGE=nginxinc/nginx-unprivileged:1.31.7-alpine
FROM ${BASE_IMAGE}
USER root
RUN apk upgrade --no-cache
USER 101
