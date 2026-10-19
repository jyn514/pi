FROM node:24-alpine3.24

# Used by pi-test.sh, .pi/skills/interactive-testing.md, and dotfiles' focused tests.
RUN apk add --no-cache bash tmux python3 uv

RUN uv venv /opt/test-venv \
    && uv pip install --python /opt/test-venv/bin/python \
       pytest==9.1.1 \
       pytest-xdist==3.8.0 \
       pytest-sugar==1.1.1 \
       pytest-instafail==0.5.0
ENV PATH="/opt/test-venv/bin:$PATH"

RUN uv --version \
    && uvx --version \
    && pytest --help > /tmp/pytest-help \
    && grep -q -e --instafail /tmp/pytest-help \
    && grep -q -e --numprocesses /tmp/pytest-help \
    && grep -q -e --force-sugar /tmp/pytest-help \
    && rm /tmp/pytest-help
