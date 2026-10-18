#!/usr/bin/env bash
# Prepara o banco do projeto, rodando só o que falta:
#   1. o banco "ifood" não existe          → cria
#   2. o banco está vazio (sem tabela users) → aplica db/init.sql (o schema completo atual)
#   3. cada db/migrations/*.sql ainda não registrado em schema_migrations → roda e registra
# As migrações são idempotentes, então rodá-las num banco que já nasceu do init.sql, ou num banco
# antigo que ainda não tinha a tabela schema_migrations, é seguro.
#
# Uso:  ./db/migrate.sh [status]
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
[ -n "$ENGINE" ] || { echo "migrate: nem docker nem podman encontrados" >&2; exit 1; }

log() { printf 'migrate: %s\n' "$*"; }
die() { printf 'migrate: ERRO: %s\n' "$*" >&2; exit 1; }

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

migration_files() {
  local f
  for f in "$DB_DIR"/migrations/*.sql; do
    [ -e "$f" ] || continue
    basename "$f"
  done | LC_ALL=C sort
}

ensure_tracking_table() {
  psql_db -c "SET client_min_messages TO warning; CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )" >/dev/null
}

is_applied() { [ -n "$(psql_db -c "SELECT 1 FROM schema_migrations WHERE filename = '$1'")" ]; }

command_status() {
  wait_for_postgres
  if [ -z "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'")" ]; then
    log "banco '$PG_DB' ainda não existe"
    return 0
  fi
  ensure_tracking_table
  local f files
  mapfile -t files < <(migration_files)
  for f in "${files[@]}"; do
    if is_applied "$f"; then log "aplicada  $f"; else log "pendente  $f"; fi
  done
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
  fi

  ensure_tracking_table

  local applied=0 skipped=0 f files
  mapfile -t files < <(migration_files)
  for f in "${files[@]}"; do
    case "$f" in
      *[!A-Za-z0-9_.-]*) die "nome de migração inválido: $f" ;;
    esac
    if is_applied "$f"; then
      skipped=$((skipped + 1))
      continue
    fi
    log "aplicando migração $f"
    # Tudo ou nada: o registro entra na mesma transação do SQL da migração.
    {
      echo "SET client_min_messages TO warning;"
      cat "$DB_DIR/migrations/$f"
      printf "\nINSERT INTO schema_migrations (filename) VALUES ('%s') ON CONFLICT DO NOTHING;\n" "$f"
    } | psql_db_stdin --single-transaction -f - >/dev/null \
      || die "a migração $f falhou (nada foi alterado por ela)"
    applied=$((applied + 1))
  done

  log "pronto: $applied aplicada(s), $skipped já estava(m) em dia"
}

case "${1:-apply}" in
  apply) command_apply ;;
  status) command_status ;;
  *) echo "uso: $0 [apply|status]" >&2; exit 2 ;;
esac
