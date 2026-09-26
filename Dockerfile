# syntax=docker/dockerfile:1
#
# Dark Pool enclave sunucusu — yerel (attestation'sız) geliştirme imajı.
# Aynı binary CVM adımında Oyster/Nitro/Phala imajına taşınacak; orada
# TEE_PROVIDER değişir, çekirdek değişmez.

FROM rust:1.95-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY tee-core tee-core
COPY tee-attest tee-attest
COPY tee-server tee-server
COPY relayer relayer
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p dark-tee-server -p darkpool-relayer \
 && mkdir -p /out /data \
 && cp target/release/dark-tee-server target/release/dev-client target/release/darkpool-relayer /out/

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/dark-tee-server /out/dev-client /out/darkpool-relayer /usr/local/bin/
# Yerel seed dosyası için yazılabilir dizin (nonroot = 65532)
COPY --from=build --chown=65532:65532 /data /data
ENV TEE_PROVIDER=local \
    LISTEN_ADDR=0.0.0.0:8080 \
    RUST_LOG=info
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/dark-tee-server"]
