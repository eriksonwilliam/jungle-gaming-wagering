import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. Escrita à mão (não gerada por diff de entidades) porque as
 * garantias de unicidade/imutabilidade/não-negatividade exigidas pelo desafio
 * — índice único parcial de reversão e o trigger de imutabilidade do ledger —
 * não têm equivalente em decorator do MikroORM. Ver ARCHITECTURE.md §5.
 */
export class Migration20260101120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance_minor_units bigint not null check (balance_minor_units >= 0),
        version integer not null default 1,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_key unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets(id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount_minor_units bigint not null,
        currency char(3) not null,
        reference_external_transaction_id text null,
        created_at timestamptz not null,
        status text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_transaction_id uuid null references wager_transactions(id),
        failure_code text null,
        processed_at timestamptz null,
        reference_attempts int not null default 0,
        reference_next_attempt_at timestamptz null,
        constraint wager_tx_provider_external_key unique (provider_id, external_transaction_id),
        constraint wager_tx_idempotency_key_key unique (idempotency_key)
      );
    `);
    this.addSql(`create index wager_tx_wallet_id_idx on wager_transactions (wallet_id);`);
    this.addSql(`create index wager_tx_pending_reference_idx on wager_transactions (status, reference_next_attempt_at);`);
    // Reversão única por tipo: uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
    this.addSql(`
      create unique index wager_tx_reversal_once_idx
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id),
        direction text not null check (direction in ('DEBIT','CREDIT')),
        amount_minor_units bigint not null,
        currency char(3) not null,
        balance_before_minor_units bigint not null,
        balance_after_minor_units bigint not null,
        created_at timestamptz not null,
        constraint ledger_wallet_transaction_key unique (wallet_id, transaction_id)
      );
    `);
    this.addSql(`create index ledger_wallet_created_idx on wallet_ledger_entries (wallet_id, created_at);`);

    // Ledger imutável: nem a aplicação nem acesso direto ao banco podem alterar um lançamento já gravado.
    this.addSql(`
      create function reject_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries e append-only: % nao permitido', TG_OP;
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update
        before update on wallet_ledger_entries
        for each row execute function reject_ledger_mutation();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_delete
        before delete on wallet_ledger_entries
        for each row execute function reject_ledger_mutation();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts int not null default 0,
        next_attempt_at timestamptz null,
        published_at timestamptz null
      );
    `);
    this.addSql(`create index outbox_pending_idx on outbox_messages (published_at, next_attempt_at);`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_no_delete on wallet_ledger_entries;`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_no_update on wallet_ledger_entries;`);
    this.addSql(`drop function if exists reject_ledger_mutation;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
  }
}
