# Claude Code -> local OpenTelemetry collector (agents-observability stack).
# Applies to every Claude Code session on this machine, personal or company.
# Install: append to ~/.config/fish/config.fish, or `source` this file from it.

set -gx CLAUDE_CODE_ENABLE_TELEMETRY 1
set -gx OTEL_METRICS_EXPORTER otlp
set -gx OTEL_LOGS_EXPORTER otlp
set -gx OTEL_EXPORTER_OTLP_PROTOCOL grpc
set -gx OTEL_EXPORTER_OTLP_ENDPOINT http://localhost:47317

# Intervalo de envio. Estes valores rodam em TODA sessao do Claude Code, entao
# sao os que mais pesam na bateria: cada envio acorda o processo, a rede local e
# o collector. 60s/30s mantem o dashboard util (a janela mais curta que ele
# desenha e de 15min) e acorda 6x menos que os 10s/5s anteriores.
set -gx OTEL_METRIC_EXPORT_INTERVAL 60000
set -gx OTEL_LOGS_EXPORT_INTERVAL 30000
