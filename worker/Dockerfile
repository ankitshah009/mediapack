# Build from worker/: docker build -t mediapack-worker:local worker
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS whisper
RUN apk add --no-cache build-base cmake curl ca-certificates
# Official release v1.9.5, fixed commit and verified archive checksum.
ARG WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
ARG WHISPER_SOURCE_SHA256=645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4
# ggml multilingual base, pinned Hugging Face revision and LFS SHA-256.
ARG WHISPER_MODEL_REVISION=5359861c739e955e79d9a303bcbc70fb988958b1
ARG WHISPER_MODEL_SHA256=60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe
WORKDIR /whisper
RUN curl --fail --location --retry 3 --max-time 120 "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${WHISPER_COMMIT}" -o source.tar.gz \
    && echo "${WHISPER_SOURCE_SHA256}  source.tar.gz" | sha256sum -c - \
    && tar -xzf source.tar.gz --strip-components=1 \
    && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_CUDA=OFF -DGGML_METAL=OFF -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build build --target whisper-cli -j 2 \
    && mkdir -p /models \
    && curl --fail --location --retry 3 --max-time 180 "https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-base.bin" -o /models/ggml-base.bin \
    && echo "${WHISPER_MODEL_SHA256}  /models/ggml-base.bin" | sha256sum -c - \
    && build/bin/whisper-cli --version

FROM node:22-alpine
RUN apk add --no-cache ffmpeg ca-certificates libstdc++ libgcc
COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api
COPY --from=whisper /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /models/ggml-base.bin /opt/whisper/ggml-base.bin
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json /build/package-lock.json ./
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
USER node
ENV BL_SANDBOX_USER_ENABLED=true
ENV WHISPER_CPP_BIN=/usr/local/bin/whisper-cli WHISPER_MODEL_PATH=/opt/whisper/ggml-base.bin
EXPOSE 8080
# Process/file APIs are required by the Blaxel launcher, which starts node dist/run.js.
CMD ["/usr/local/bin/sandbox-api"]
