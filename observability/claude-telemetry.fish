# Claude Code -> local OpenTelemetry collector (agents-observability stack).
# Applies to every Claude Code session on this machine, personal or company.
# Install: append to ~/.config/fish/config.fish, or `source` this file from it.

set -gx CLAUDE_CODE_ENABLE_TELEMETRY 1
set -gx OTEL_METRICS_EXPORTER otlp
set -gx OTEL_LOGS_EXPORTER otlp
set -gx OTEL_EXPORTER_OTLP_PROTOCOL grpc
set -gx OTEL_EXPORTER_OTLP_ENDPOINT http://localhost:47317

# Push metrics/logs every 10s and 5s instead of the 60s/5s defaults (faster dashboards).
set -gx OTEL_METRIC_EXPORT_INTERVAL 10000
set -gx OTEL_LOGS_EXPORT_INTERVAL 5000
