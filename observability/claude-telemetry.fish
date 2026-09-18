# Claude Code -> local OpenTelemetry collector (agents-observability stack).
# For fish. For bash and zsh, use claude-telemetry.sh (same values).
# Install: append to ~/.config/fish/config.fish, or `source` this file from it.

set -gx CLAUDE_CODE_ENABLE_TELEMETRY 1
set -gx OTEL_METRICS_EXPORTER otlp
set -gx OTEL_LOGS_EXPORTER otlp
set -gx OTEL_EXPORTER_OTLP_PROTOCOL grpc
set -gx OTEL_EXPORTER_OTLP_ENDPOINT http://localhost:47317

# Export interval. These run in EVERY Claude Code session, so they are the
# single biggest battery cost here: each export wakes the process, the local
# network, and the collector. 60s/30s keeps the dashboard useful (its shortest
# window is 15min) while waking up 6x less than the original 10s/5s.
set -gx OTEL_METRIC_EXPORT_INTERVAL 60000
set -gx OTEL_LOGS_EXPORT_INTERVAL 30000
