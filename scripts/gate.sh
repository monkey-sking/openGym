#!/usr/bin/env bash
# 转发到 DSH 通用门禁 runner（delivery-gates skill）
exec "$HOME/.dsh/skills/delivery-gates/gate.sh" "$@"
