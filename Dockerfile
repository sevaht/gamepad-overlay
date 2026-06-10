FROM archlinux AS base
SHELL ["/bin/bash", "-eu", "-c"]

FROM base AS python-build
RUN pacman -Syu --noconfirm --needed python tk sdl3 uv git \
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
