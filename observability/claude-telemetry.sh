# Claude Code -> local OpenTelemetry collector (agents-observability stack).
# For bash and zsh. For fish, use claude-telemetry.fish (same values).
#
# Install:
#   cat observability/claude-telemetry.sh >> ~/.bashrc    # or ~/.zshrc
#
# Applies to every Claude Code session on this machine, whichever account is active.

export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:47317

# Export interval. These run in EVERY Claude Code session, so they are the
# single biggest battery cost here: each export wakes the process, the local
# network, and the collector. 60s/30s keeps the dashboard useful (its shortest
# window is 15min) while waking up 6x less than the original 10s/5s.
export OTEL_METRIC_EXPORT_INTERVAL=60000
export OTEL_LOGS_EXPORT_INTERVAL=30000
