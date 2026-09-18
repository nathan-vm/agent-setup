# Claude Code -> collector OpenTelemetry local (stack agents-observability).
# Vale para bash e zsh. Para fish, use claude-telemetry.fish (mesmos valores).
#
# Instalar:
#   cat observability/claude-telemetry.sh >> ~/.bashrc    # ou ~/.zshrc
#
# Aplica a toda sessão do Claude Code nesta máquina, seja qual for a conta ativa.

export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:47317

# Intervalo de envio. Estes valores rodam em TODA sessão do Claude Code, então
# são os que mais pesam na bateria: cada envio acorda o processo, a rede local e
# o collector. 60s/30s mantém o dashboard útil (a janela mais curta que ele
# desenha é de 15min) e acorda 6x menos que os 10s/5s originais.
export OTEL_METRIC_EXPORT_INTERVAL=60000
export OTEL_LOGS_EXPORT_INTERVAL=30000
