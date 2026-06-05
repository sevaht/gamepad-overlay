FROM archlinux AS base
SHELL ["/bin/bash", "-eu", "-c"]

FROM base AS python-runtime
RUN pacman -Syu --noconfirm --needed python python-wheel \
    && pacman -Sc --noconfirm

FROM python-runtime AS python-build
RUN pacman -Syu --noconfirm --needed python-uv \
    && pacman -Sc --noconfirm

FROM python-build AS source-prepared
ENV SETUPTOOLS_SCM_PRETEND_VERSION=0.0.0+test.bypass
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --no-install-project
COPY ./ ./
RUN uv sync --no-dev

FROM source-prepared AS test
RUN uv sync
ENV PATH="/app/.venv/bin:$PATH"
CMD ["./checks"]

FROM python-runtime AS final
WORKDIR /app
COPY --from=source-prepared /app /app
ENV PATH="/app/.venv/bin:$PATH"
CMD ["gamepad-server"]
