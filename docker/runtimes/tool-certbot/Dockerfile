# Certificate tool: official certbot image plus Alpine and Python dependency security updates.
# The minimum versions are the fixed versions named by the Trivy scan (certifi/uv: emSign root CA, urllib3, msgpack, setuptools).
ARG BASE_IMAGE=certbot/certbot:v5.9.0
FROM ${BASE_IMAGE}
RUN apk upgrade --no-cache \
 && pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir --upgrade 'certifi>=2026.10.18' 'urllib3>=2.8.0' 'msgpack>=1.2.3' 'setuptools>=78.1.1' 'uv>=0.13.4' \
 && certbot --version
