#!/usr/bin/env bash
# Prepara o banco do projeto, rodando só o que falta:
#   1. o banco "ifood" não existe          → cria
#   2. o banco está vazio (sem tabela users) → aplica db/init.sql (o schema completo)
# Não há migrações: o schema muda direto no init.sql. Um banco criado com um schema antigo
# (sem a tabela chats) é recusado com a instrução de recriar (./dev.sh reset --yes).
#
# Uso:  ./db/setup.sh
# Fala com o Postgres dentro do container (docker ou podman), sem precisar de psql no host.
#   CONTAINER_ENGINE  docker | podman   (padrão: o primeiro que existir)
#   PG_CONTAINER      nome do container (padrão: ifood-postgres)
#   PG_USER / PG_DB   (padrão: ifood / ifood)
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_CONTAINER="${PG_CONTAINER:-ifood-postgres}"
PG_USER="${PG_USER:-ifood}"
PG_DB="${PG_DB:-ifood}"

ENGINE="${CONTAINER_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  for candidate in docker podman; do
    if command -v "$candidate" >/dev/null 2>&1; then ENGINE="$candidate"; break; fi
  done
fi
[ -n "$ENGINE" ] || { echo "setup: nem docker nem podman encontrados" >&2; exit 1; }

log() { printf 'setup: %s\n' "$*"; }
die() { printf 'setup: ERRO: %s\n' "$*" >&2; exit 1; }

# -q silencia o eco; -At devolve só os valores, sem formatação.
# Sem -i: nada aqui lê stdin (com -i o exec engoliria o stdin de quem chamou).
psql_admin() { "$ENGINE" exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
psql_db() { "$ENGINE" exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -qAt "$@"; }
# Com -i: recebe um SQL por stdin.
psql_db_stdin() { "$ENGINE" exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q "$@"; }

# Pronto de verdade = aceitando conexões TCP. Durante a criação do volume o entrypoint do Postgres
# sobe um servidor temporário só em socket unix; checar por TCP evita correr junto com ele.
wait_for_postgres() {
  local i
  for i in $(seq 1 90); do
    if "$ENGINE" exec "$PG_CONTAINER" pg_isready -h 127.0.0.1 -U "$PG_USER" -q >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "o Postgres ($PG_CONTAINER) não ficou pronto em 90s"
}

command_apply() {
  wait_for_postgres

  if [ -z "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'")" ]; then
    log "criando o banco '$PG_DB'"
    psql_admin -c "CREATE DATABASE \"$PG_DB\"" >/dev/null
  fi

  if [ "$(psql_db -c "SELECT to_regclass('public.users') IS NOT NULL")" != "t" ]; then
    log "banco vazio: aplicando db/init.sql (schema completo)"
    psql_db_stdin -f - <"$DB_DIR/init.sql" >/dev/null
  elif [ "$(psql_db -c "SELECT to_regclass('public.chats') IS NOT NULL")" != "t" ]; then
    die "o banco '$PG_DB' tem um schema antigo (sem a tabela chats): recrie com ./dev.sh reset --yes"
  fi

  log "pronto: schema em dia"
}

case "${1:-apply}" in
  apply) command_apply ;;
  *) echo "uso: $0 [apply]" >&2; exit 2 ;;
esac
