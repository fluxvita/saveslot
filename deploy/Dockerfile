# The saveslot server mode as a container image (docs/zh-CN/spec/02-architecture.md §9, self-hosting;
# 06-cli.md §4.1, `saveslot server …` and «服务器模式的配置»). Build it with deploy/build-image.sh
# from the repository root. The image holds no key, password or connection string: all of them come
# from the environment when the container runs. TLS ends at the deployer's reverse proxy (§9); the
# process listens on plain HTTP.

# node:24-bookworm-slim, pinned by digest. Debian (glibc): the native addon in the dependencies has
# prebuilt binaries for glibc on x64 and arm64.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY . .
# The entry package with its production dependencies only, the workspace packages copied in built.
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @fluxvita/saveslot deploy --prod /out

FROM ${NODE_IMAGE}
COPY --from=build /out /opt/saveslot
# A user of its own, no login; /var/lib/saveslot is where the handle key file is kept by default.
RUN ln -s /opt/saveslot/dist/bin.js /usr/local/bin/saveslot \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin saveslot \
 && install -d -o saveslot -g saveslot -m 0700 /var/lib/saveslot
USER saveslot
# saveslot listens on loopback by default (plain HTTP, 06-cli §4.1); in a container the reverse
# proxy is outside, so the image listens on every interface of the container, written out here.
# Publish the port to the reverse proxy only (compose.yaml maps it to the host's 127.0.0.1).
ENV SAVESLOT_LISTEN=0.0.0.0:8080 \
    SAVESLOT_HANDLE_KEY_FILE=/var/lib/saveslot/handle-key
EXPOSE 8080
# /ready takes no token and answers 200 only while the server is ready (06-cli §4.1 `saveslot
# server start`). Asked at the address SAVESLOT_LISTEN gives when the container runs; a wildcard
# address (0.0.0.0, [::]) is asked on 127.0.0.1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "const l=process.env.SAVESLOT_LISTEN??'',i=l.lastIndexOf(':'),h=l.slice(0,i);fetch(`http://${['','0.0.0.0','[::]'].includes(h)?'127.0.0.1':h}:${l.slice(i+1)}/ready`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["saveslot", "server"]
CMD ["start"]
