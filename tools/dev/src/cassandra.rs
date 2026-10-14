// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::paths::DEV_CASSANDRA_DIR;
use anyhow::{Context, Result, bail};
use regex::Regex;
use scylla::DeserializeRow;
use scylla::client::session::Session;
use scylla::client::session_builder::SessionBuilder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::time::sleep;

pub const DEV_KEYSPACE_REPLICATION: &str = "{'class': 'SimpleStrategy', 'replication_factor': 1}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CassandraConfig {
    pub hosts: Vec<String>,
    pub port: u16,
    pub keyspace: String,
    pub local_dc: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub replication: Option<String>,
    /// `--dev`: a local single-node cluster, where an RF=1 keyspace is not refused.
    pub dev: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExistingTable {
    pub columns: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExistingSchema {
    pub keyspace_exists: bool,
    pub replication: BTreeMap<String, String>,
    pub types: BTreeMap<String, BTreeMap<String, String>>,
    pub tables: BTreeMap<String, ExistingTable>,
    pub indexes: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaDiff {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub target_sha256: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct UserType {
    pub name: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Field>,
    pub primary_key: String,
    pub options: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Index {
    pub name: String,
    pub table: String,
    pub expression: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TargetSchema {
    pub user_types: Vec<UserType>,
    pub tables: Vec<Table>,
    pub indexes: Vec<Index>,
}

static TARGET_SCHEMA: LazyLock<TargetSchema> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../cassandra_target_schema.json"))
        .expect("embedded Cassandra target schema JSON is valid")
});

static TYPE_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-zA-Z_][a-zA-Z0-9_]*").expect("valid type token regex"));
static WHITESPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("valid whitespace regex"));

pub fn target_schema() -> &'static TargetSchema {
    &TARGET_SCHEMA
}

pub fn config_from_env() -> Result<CassandraConfig> {
    let hosts = env::var("FLUXER_CASSANDRA_HOSTS").unwrap_or_default();
    let replication = env::var("FLUXER_CASSANDRA_REPLICATION").unwrap_or_default();
    Ok(CassandraConfig {
        hosts: parse_hosts(&hosts),
        port: env::var("FLUXER_CASSANDRA_PORT")
            .unwrap_or_else(|_| "9042".to_owned())
            .parse()
            .context("invalid FLUXER_CASSANDRA_PORT")?,
        keyspace: env::var("FLUXER_CASSANDRA_KEYSPACE").unwrap_or_else(|_| "fluxer".to_owned()),
        local_dc: env::var("FLUXER_CASSANDRA_LOCAL_DC")
            .unwrap_or_else(|_| "datacenter1".to_owned()),
        username: env::var("FLUXER_CASSANDRA_USERNAME")
            .ok()
            .filter(|value| !value.is_empty()),
        password: env::var("FLUXER_CASSANDRA_PASSWORD")
            .ok()
            .filter(|value| !value.is_empty()),
        replication: parse_replication(&replication)?,
        dev: false,
    })
}

impl CassandraConfig {
    pub fn with_replication(mut self, replication: Option<&str>, dev: bool) -> Result<Self> {
        self.dev = dev;
        if let Some(replication) = parse_replication(replication.unwrap_or_default())? {
            self.replication = Some(replication);
        } else if dev && self.replication.is_none() {
            self.replication = Some(DEV_KEYSPACE_REPLICATION.to_owned());
        }
        Ok(self)
    }
}

fn parse_hosts(value: &str) -> Vec<String> {
    let hosts = value
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if hosts.is_empty() {
        vec!["cassandra".to_owned()]
    } else {
        hosts
    }
}

fn parse_replication(value: &str) -> Result<Option<String>> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if !value.starts_with('{') || !value.ends_with('}') || value.contains(';') {
        bail!(
            "invalid Cassandra keyspace replication {value:?}: expected one CQL map such as \
             {{'class': 'NetworkTopologyStrategy', '<datacenter>': 3}}"
        );
    }
    Ok(Some(value.to_owned()))
}

/// Reads a CQL map such as `{'class': 'NetworkTopologyStrategy', 'fsn1': 3}`; empty when it is
/// not one.
fn parse_replication_map(value: &str) -> BTreeMap<String, String> {
    let unquote = |part: &str| part.trim().trim_matches('\'').to_owned();
    value
        .trim()
        .strip_prefix('{')
        .and_then(|body| body.strip_suffix('}'))
        .and_then(|body| {
            body.split(',')
                .map(|pair| {
                    let (key, factor) = pair.split_once(':')?;
                    Some((unquote(key), unquote(factor)))
                })
                .collect::<Option<BTreeMap<_, _>>>()
        })
        .unwrap_or_default()
}

/// Why a keyspace replication would lose data or quorum once one node of a multi-host cluster
/// is down, if it would: SimpleStrategy, or any datacentre with fewer than min(3, hosts)
/// replicas. One host and `--dev` are never refused.
fn replication_problem(
    replication: &BTreeMap<String, String>,
    hosts: usize,
    dev: bool,
) -> Option<String> {
    if dev || hosts < 2 {
        return None;
    }
    let required = hosts.min(3);
    let class = replication.get("class").map_or("", String::as_str);
    let factors = replication
        .iter()
        .filter(|(key, _)| key.as_str() != "class")
        .map(|(_, factor)| factor.trim().parse::<usize>().ok())
        .collect::<Vec<_>>();
    let safe = !class.ends_with("SimpleStrategy")
        && !factors.is_empty()
        && factors
            .iter()
            .all(|factor| factor.is_some_and(|factor| factor >= required));
    (!safe).then(|| {
        format!(
            "replication {replication:?} is unsafe on {hosts} Cassandra hosts: use \
             NetworkTopologyStrategy with at least {required} replicas in every datacenter \
             (--dev is only for a local single-node cluster)"
        )
    })
}

fn contact_points(config: &CassandraConfig) -> Vec<String> {
    config
        .hosts
        .iter()
        .map(|host| format!("{host}:{}", config.port))
        .collect()
}

async fn connect(config: &CassandraConfig) -> Result<Session> {
    let mut builder = SessionBuilder::new().known_nodes(contact_points(config));
    if let Some(username) = &config.username {
        builder = builder.user(username, config.password.as_deref().unwrap_or_default());
    }
    Ok(builder.build().await?)
}

pub async fn wait_for_cassandra(config: &CassandraConfig, timeout_secs: u64) -> Result<()> {
    let contact = contact_points(config).join(", ");
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_error = None;
    while Instant::now() < deadline {
        match connect(config).await {
            Ok(session) => match session
                .query_unpaged("SELECT release_version FROM system.local", ())
                .await
            {
                Ok(_) => {
                    println!("Cassandra is reachable at {contact}");
                    return Ok(());
                }
                Err(error) => last_error = Some(error.to_string()),
            },
            Err(error) => last_error = Some(error.to_string()),
        }
        sleep(Duration::from_secs(3)).await;
    }
    bail!(
        "Timed out waiting for Cassandra at {contact}: {}",
        last_error.unwrap_or_else(|| "unknown error".to_owned())
    );
}

pub fn normalize_type(value: &str) -> String {
    let mut normalized = WHITESPACE_RE.replace_all(value, "").to_ascii_lowercase();
    let user_type_names = target_schema()
        .user_types
        .iter()
        .map(|user_type| user_type.name.as_str())
        .collect::<Vec<_>>();
    let mut previous = String::new();
    while previous != normalized {
        previous = normalized.clone();
        for name in &user_type_names {
            normalized = normalized.replace(&format!("frozen<{name}>"), name);
        }
    }
    normalized
}

fn normalize_identifier(value: &str) -> String {
    value.trim_matches('"').to_ascii_lowercase()
}

#[derive(Debug, DeserializeRow)]
struct KeyspaceRow {
    replication: BTreeMap<String, String>,
}

#[derive(Debug, DeserializeRow)]
struct TypeRow {
    type_name: String,
    field_names: Option<Vec<String>>,
    field_types: Option<Vec<String>>,
}

#[derive(Debug, DeserializeRow)]
struct ColumnRow {
    table_name: String,
    column_name: String,
    #[scylla(rename = "type")]
    column_type: String,
}

#[derive(Debug, DeserializeRow)]
struct IndexRow {
    index_name: Option<String>,
}

pub async fn fetch_existing_schema(session: &Session, keyspace: &str) -> Result<ExistingSchema> {
    let keyspace_rows = session
        .query_unpaged(
            "SELECT replication FROM system_schema.keyspaces WHERE keyspace_name = ?",
            (keyspace,),
        )
        .await?
        .into_rows_result()?
        .rows::<KeyspaceRow>()?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let type_rows = session
        .query_unpaged(
            "SELECT type_name, field_names, field_types FROM system_schema.types WHERE keyspace_name = ?",
            (keyspace,),
        )
        .await?
        .into_rows_result()?
        .rows::<TypeRow>()?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut types = BTreeMap::new();
    for row in type_rows {
        let mut fields = BTreeMap::new();
        for (name, field_type) in row
            .field_names
            .unwrap_or_default()
            .into_iter()
            .zip(row.field_types.unwrap_or_default())
        {
            fields.insert(normalize_identifier(&name), field_type);
        }
        types.insert(normalize_identifier(&row.type_name), fields);
    }

    let column_rows = session
        .query_unpaged(
            "SELECT table_name, column_name, type FROM system_schema.columns WHERE keyspace_name = ?",
            (keyspace,),
        )
        .await?
        .into_rows_result()?
        .rows::<ColumnRow>()?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut tables: BTreeMap<String, ExistingTable> = BTreeMap::new();
    for row in column_rows {
        tables
            .entry(normalize_identifier(&row.table_name))
            .or_default()
            .columns
            .insert(normalize_identifier(&row.column_name), row.column_type);
    }

    let index_rows = session
        .query_unpaged(
            "SELECT index_name FROM system_schema.indexes WHERE keyspace_name = ?",
            (keyspace,),
        )
        .await?
        .into_rows_result()?
        .rows::<IndexRow>()?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let indexes = index_rows
        .into_iter()
        .filter_map(|row| row.index_name)
        .map(|name| normalize_identifier(&name))
        .collect();

    let replication = keyspace_rows.into_iter().next().map(|row| row.replication);
    Ok(ExistingSchema {
        keyspace_exists: replication.is_some(),
        replication: replication.unwrap_or_default(),
        types,
        tables,
        indexes,
    })
}

pub fn render_user_type(user_type: &UserType, keyspace: &str) -> String {
    let fields = user_type
        .fields
        .iter()
        .map(|field| format!("{} {}", field.name, field.field_type))
        .collect::<Vec<_>>()
        .join(",\n    ");
    format!(
        "CREATE TYPE IF NOT EXISTS {keyspace}.{} (\n    {fields}\n)",
        user_type.name
    )
}

pub fn render_table(table: &Table, keyspace: &str) -> String {
    let mut fields = table
        .columns
        .iter()
        .map(|field| format!("{} {}", field.name, field.field_type))
        .collect::<Vec<_>>();
    fields.push(format!("PRIMARY KEY {}", table.primary_key));
    let body = fields.join(",\n    ");
    let mut statement = format!(
        "CREATE TABLE IF NOT EXISTS {keyspace}.{} (\n    {body}\n)",
        table.name
    );
    if !table.options.is_empty() {
        statement.push_str(" WITH ");
        statement.push_str(&table.options);
    }
    statement
}

pub fn render_index(index: &Index, keyspace: &str) -> String {
    format!(
        "CREATE INDEX IF NOT EXISTS {} ON {keyspace}.{} ({})",
        index.name, index.table, index.expression
    )
}

pub fn render_target_schema(keyspace: &str) -> String {
    let schema = target_schema();
    let mut statements = Vec::new();
    for user_type in sorted_user_types() {
        statements.push(statement_with_semicolon(&render_user_type(
            &user_type, keyspace,
        )));
    }
    let mut tables = schema.tables.clone();
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    for table in tables {
        statements.push(statement_with_semicolon(&render_table(&table, keyspace)));
    }
    let mut indexes = schema.indexes.clone();
    indexes.sort_by(|a, b| a.name.cmp(&b.name));
    for index in indexes {
        statements.push(statement_with_semicolon(&render_index(&index, keyspace)));
    }
    format!("{}\n", statements.join("\n\n"))
}

pub fn target_schema_sha256(keyspace: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(render_target_schema(keyspace).as_bytes());
    bytes_to_lower_hex(&hasher.finalize())
}

fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn sorted_user_types() -> Vec<UserType> {
    let schema = target_schema();
    let by_name = schema
        .user_types
        .iter()
        .map(|user_type| (user_type.name.clone(), user_type.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut done = BTreeSet::new();
    let mut result = Vec::new();
    let mut remaining = by_name.clone();
    while !remaining.is_empty() {
        let mut progressed = false;
        for (name, user_type) in remaining.clone() {
            let deps = type_dependencies(&user_type, &by_name.keys().cloned().collect());
            if deps.is_subset(&done) {
                result.push(user_type);
                done.insert(name.clone());
                remaining.remove(&name);
                progressed = true;
            }
        }
        if !progressed {
            result.extend(remaining.into_values());
            break;
        }
    }
    result
}

fn type_dependencies(user_type: &UserType, user_type_names: &BTreeSet<String>) -> BTreeSet<String> {
    let mut deps = BTreeSet::new();
    for field in &user_type.fields {
        for token in TYPE_TOKEN_RE.find_iter(&field.field_type) {
            let token = token.as_str().to_ascii_lowercase();
            if user_type_names.contains(&token) && token != user_type.name {
                deps.insert(token);
            }
        }
    }
    deps
}

pub fn create_diff(
    existing: &ExistingSchema,
    keyspace: &str,
    config: &CassandraConfig,
) -> Result<SchemaDiff> {
    let schema = target_schema();
    let mut statements = Vec::new();
    let mut warnings = Vec::new();
    let mut errors = Vec::new();
    let replication = if existing.keyspace_exists {
        existing.replication.clone()
    } else {
        let Some(replication) = config.replication.as_deref() else {
            bail!(
                "Cassandra keyspace {keyspace} does not exist and no replication was given; \
                 create it first or pass --replication \
                 \"{{'class': 'NetworkTopologyStrategy', '<dc>': 3}}\" (env \
                 FLUXER_CASSANDRA_REPLICATION); --dev creates a local single-node RF=1 keyspace"
            );
        };
        statements.push(format!(
            "CREATE KEYSPACE IF NOT EXISTS {keyspace} WITH replication = {replication}"
        ));
        parse_replication_map(replication)
    };
    if let Some(problem) = replication_problem(&replication, config.hosts.len(), config.dev) {
        errors.push(format!("keyspace {keyspace}: {problem}"));
    }
    for user_type in sorted_user_types() {
        let Some(current_fields) = existing.types.get(&user_type.name) else {
            statements.push(render_user_type(&user_type, keyspace));
            continue;
        };
        for field in &user_type.fields {
            match current_fields.get(&field.name) {
                None => statements.push(format!(
                    "ALTER TYPE {keyspace}.{} ADD IF NOT EXISTS {} {}",
                    user_type.name, field.name, field.field_type
                )),
                Some(current_type)
                    if normalize_type(current_type) != normalize_type(&field.field_type) =>
                {
                    errors.push(format!(
                        "type {}.{} has {current_type:?}, expected {:?}",
                        user_type.name, field.name, field.field_type
                    ));
                }
                Some(_) => {}
            }
        }
    }
    let mut tables = schema.tables.clone();
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    for table in tables {
        let Some(current_table) = existing.tables.get(&table.name) else {
            statements.push(render_table(&table, keyspace));
            continue;
        };
        for field in &table.columns {
            match current_table.columns.get(&field.name) {
                None => statements.push(format!(
                    "ALTER TABLE {keyspace}.{} ADD IF NOT EXISTS {} {}",
                    table.name, field.name, field.field_type
                )),
                Some(current_type)
                    if normalize_type(current_type) != normalize_type(&field.field_type) =>
                {
                    errors.push(format!(
                        "table {}.{} has {current_type:?}, expected {:?}",
                        table.name, field.name, field.field_type
                    ));
                }
                Some(_) => {}
            }
        }
    }
    let mut indexes = schema.indexes.clone();
    indexes.sort_by(|a, b| a.name.cmp(&b.name));
    for index in indexes {
        if !existing.indexes.contains(&index.name.to_ascii_lowercase()) {
            statements.push(render_index(&index, keyspace));
        }
    }
    let target_tables = schema
        .tables
        .iter()
        .map(|table| table.name.clone())
        .collect::<BTreeSet<_>>();
    for table_name in existing.tables.keys() {
        if !target_tables.contains(table_name) && !table_name.starts_with("system_") {
            warnings.push(format!(
                "extra Cassandra table exists outside target schema: {table_name}"
            ));
        }
    }
    Ok(SchemaDiff {
        statements,
        warnings,
        errors,
        target_sha256: target_schema_sha256(keyspace),
    })
}

fn statement_with_semicolon(statement: &str) -> String {
    format!("{};", statement.trim().trim_end_matches(';'))
}

pub fn render_diff(diff: &SchemaDiff) -> String {
    let mut lines = vec![
        "-- Generated by fluxer-dev cassandra diff".to_owned(),
        format!("-- Target schema sha256: {}", diff.target_sha256),
        String::new(),
    ];
    if !diff.errors.is_empty() {
        lines.push("-- Diff contains validation errors and should not be applied:".to_owned());
        lines.extend(diff.errors.iter().map(|error| format!("--   {error}")));
        lines.push(String::new());
    }
    if !diff.warnings.is_empty() {
        lines.push("-- Warnings:".to_owned());
        lines.extend(
            diff.warnings
                .iter()
                .map(|warning| format!("--   {warning}")),
        );
        lines.push(String::new());
    }
    if diff.statements.is_empty() {
        lines.push("-- No schema changes required.".to_owned());
    } else {
        lines.extend(
            diff.statements
                .iter()
                .map(|statement| statement_with_semicolon(statement)),
        );
    }
    format!("{}\n", lines.join("\n"))
}

pub fn write_diff_file(diff: &SchemaDiff, path: Option<&Path>) -> Result<PathBuf> {
    std::fs::create_dir_all(DEV_CASSANDRA_DIR.as_path())?;
    let output = path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| DEV_CASSANDRA_DIR.join("last-diff.cql"));
    std::fs::write(&output, render_diff(diff))?;
    std::fs::write(
        DEV_CASSANDRA_DIR.join("target-schema.sha256"),
        format!("{}\n", diff.target_sha256),
    )?;
    Ok(output)
}

pub async fn compute_diff(config: Option<CassandraConfig>) -> Result<SchemaDiff> {
    let config = config.unwrap_or(config_from_env()?);
    wait_for_cassandra(&config, 180).await?;
    let session = connect(&config).await?;
    create_live_diff(&session, &config.keyspace, &config).await
}

async fn create_live_diff(
    session: &Session,
    keyspace: &str,
    config: &CassandraConfig,
) -> Result<SchemaDiff> {
    let existing = fetch_existing_schema(session, keyspace).await?;
    create_diff(&existing, keyspace, config)
}

pub async fn apply_schema(config: Option<CassandraConfig>) -> Result<SchemaDiff> {
    let config = config.unwrap_or(config_from_env()?);
    wait_for_cassandra(&config, 180).await?;
    let session = connect(&config).await?;
    let diff = create_live_diff(&session, &config.keyspace, &config).await?;
    let diff_path = write_diff_file(&diff, None)?;
    if !diff.errors.is_empty() {
        bail!(
            "Cassandra schema has validation errors; wrote {}",
            diff_path.display()
        );
    }
    for warning in &diff.warnings {
        println!("Cassandra schema warning: {warning}");
    }
    if diff.statements.is_empty() {
        println!(
            "Cassandra schema is already up to date; wrote {}",
            diff_path.display()
        );
    } else {
        println!(
            "Applying {} Cassandra schema statement(s); wrote {}",
            diff.statements.len(),
            diff_path.display()
        );
        for statement in &diff.statements {
            session.query_unpaged(statement.as_str(), ()).await?;
        }
    }
    verify_schema_with_session(&session, &config.keyspace, &config).await?;
    Ok(diff)
}

pub async fn verify_schema(
    config: Option<CassandraConfig>,
    keyspace: Option<String>,
) -> Result<()> {
    let config = config.unwrap_or(config_from_env()?);
    let keyspace = keyspace.unwrap_or_else(|| config.keyspace.clone());
    wait_for_cassandra(&config, 180).await?;
    let session = connect(&config).await?;
    verify_schema_with_session(&session, &keyspace, &config).await
}

async fn verify_schema_with_session(
    session: &Session,
    keyspace: &str,
    config: &CassandraConfig,
) -> Result<()> {
    let diff = create_live_diff(session, keyspace, config).await?;
    let unapplied = diff.statements.clone();
    if !diff.errors.is_empty() || !unapplied.is_empty() {
        write_diff_file(&diff, None)?;
        let mut problems = diff.errors;
        problems.extend(
            unapplied
                .into_iter()
                .take(10)
                .map(|statement| format!("still needs: {statement}")),
        );
        bail!(
            "Cassandra schema verification failed:\n{}",
            problems
                .into_iter()
                .map(|item| format!("  - {item}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    println!(
        "Cassandra schema verified: {} types, {} tables, {} indexes, target {}",
        target_schema().user_types.len(),
        target_schema().tables.len(),
        target_schema().indexes.len(),
        &diff.target_sha256[..12],
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_frozen_user_type_wrappers() {
        assert_eq!(normalize_type(" frozen<message_embed> "), "message_embed");
        assert_eq!(
            normalize_type("LIST< frozen<message_embed> >"),
            "list<message_embed>"
        );
    }

    #[test]
    fn renders_target_schema_with_semicolons() {
        let rendered = render_target_schema("fluxer");
        assert!(rendered.starts_with("CREATE TYPE IF NOT EXISTS fluxer."));
        assert!(rendered.contains("CREATE TABLE IF NOT EXISTS fluxer.messages"));
        assert!(rendered.ends_with(";\n"));
    }

    const NTS: &str = "{'class': 'NetworkTopologyStrategy', 'fsn1': 3}";

    const THREE_HOSTS: &str = "10.88.0.11,10.88.0.12,10.88.0.13";

    fn test_config(hosts: &str, replication: Option<&str>) -> CassandraConfig {
        CassandraConfig {
            hosts: parse_hosts(hosts),
            port: 9042,
            keyspace: "fluxer".to_owned(),
            local_dc: "fsn1".to_owned(),
            username: None,
            password: None,
            replication: replication.map(str::to_owned),
            dev: false,
        }
    }

    fn replication_map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn pick(env: Option<&str>, cli: Option<&str>, dev: bool) -> Option<String> {
        let config = test_config("", env).with_replication(cli, dev).unwrap();
        config.replication
    }

    #[test]
    fn diff_refuses_missing_keyspace_without_replication() {
        let config = test_config("", None);
        let error = create_diff(&ExistingSchema::default(), "fluxer", &config).unwrap_err();
        assert!(error.to_string().contains("--replication"));
    }

    #[test]
    fn diff_never_touches_an_existing_keyspace() {
        let existing = ExistingSchema {
            keyspace_exists: true,
            ..ExistingSchema::default()
        };
        for replication in [None, Some(NTS)] {
            let diff = create_diff(&existing, "fluxer", &test_config("", replication)).unwrap();
            assert!(!render_diff(&diff).contains("KEYSPACE"));
        }
    }

    #[test]
    fn replication_problem_refuses_keyspaces_that_lose_a_node_on_many_hosts() {
        let nts = |hel1: &str| {
            replication_map(&[
                ("class", "NetworkTopologyStrategy"),
                ("fsn1", "3"),
                ("hel1", hel1),
            ])
        };
        let simple = replication_map(&[
            ("class", "org.apache.cassandra.locator.SimpleStrategy"),
            ("replication_factor", "3"),
        ]);
        let no_datacenter = replication_map(&[("class", "NetworkTopologyStrategy")]);
        assert!(replication_problem(&nts("3"), 3, false).is_none());
        assert!(replication_problem(&nts("2"), 3, false).is_some());
        assert!(replication_problem(&nts("2"), 2, false).is_none());
        assert!(replication_problem(&nts("three"), 3, false).is_some());
        assert!(replication_problem(&simple, 3, false).is_some());
        assert!(replication_problem(&no_datacenter, 3, false).is_some());
    }

    #[test]
    fn replication_problem_allows_rf1_only_on_one_host_or_with_dev() {
        let rf1 = parse_replication_map(DEV_KEYSPACE_REPLICATION);
        assert!(replication_problem(&rf1, 1, false).is_none());
        assert!(replication_problem(&rf1, 3, true).is_none());
        assert!(replication_problem(&rf1, 2, false).is_some());
        assert!(replication_problem(&rf1, 3, false).is_some());
    }

    #[test]
    fn reads_cql_replication_maps() {
        assert_eq!(
            parse_replication_map(NTS),
            replication_map(&[("class", "NetworkTopologyStrategy"), ("fsn1", "3")])
        );
        assert_eq!(
            parse_replication_map("{'class':'SimpleStrategy','replication_factor':1}"),
            replication_map(&[("class", "SimpleStrategy"), ("replication_factor", "1")])
        );
        assert!(parse_replication_map("{'class', 'fsn1': 3}").is_empty());
    }

    #[test]
    fn diff_refuses_rf1_keyspaces_on_many_hosts_unless_dev() {
        let errors = |existing: &ExistingSchema, config: &CassandraConfig| {
            create_diff(existing, "fluxer", config).unwrap().errors
        };
        let existing_rf1 = ExistingSchema {
            keyspace_exists: true,
            replication: parse_replication_map(DEV_KEYSPACE_REPLICATION),
            ..ExistingSchema::default()
        };
        let many = test_config(THREE_HOSTS, None);
        let given_rf1 = test_config(
            THREE_HOSTS,
            Some("{'class':'SimpleStrategy','replication_factor':1}"),
        );
        for refused in [
            errors(&existing_rf1, &many),
            errors(&ExistingSchema::default(), &given_rf1),
        ] {
            assert!(refused.iter().any(|error| error.contains("unsafe")));
        }

        let dev = many.with_replication(None, true).unwrap();
        assert!(dev.dev);
        assert!(errors(&existing_rf1, &dev).is_empty());
        assert!(errors(&existing_rf1, &test_config("", None)).is_empty());
    }

    #[test]
    fn dev_replication_is_only_a_fallback() {
        let dev = Some(DEV_KEYSPACE_REPLICATION.to_owned());
        let cli = "{'class': 'NetworkTopologyStrategy', 'fsn1': 3, 'hel1': 3}";
        assert_eq!(pick(None, None, false), None);
        assert_eq!(pick(None, None, true), dev);
        assert_eq!(pick(Some(NTS), None, true), Some(NTS.to_owned()));
        assert_eq!(pick(Some(NTS), Some(cli), false), Some(cli.to_owned()));
    }

    #[test]
    fn replication_must_be_a_single_cql_map() {
        assert_eq!(parse_replication("  ").unwrap(), None);
        let trimmed = parse_replication(&format!(" {NTS} ")).unwrap();
        assert_eq!(trimmed, Some(NTS.to_owned()));
        assert!(parse_replication("NetworkTopologyStrategy").is_err());
        assert!(parse_replication("{'a': 1}; DROP KEYSPACE fluxer; {'b': 2}").is_err());
    }

    #[test]
    fn connects_to_every_configured_host() {
        let config = test_config(" 10.88.0.11, 10.88.0.12,,10.88.0.13 ", None);
        assert_eq!(
            contact_points(&config),
            ["10.88.0.11:9042", "10.88.0.12:9042", "10.88.0.13:9042"]
        );
        assert_eq!(parse_hosts(""), ["cassandra"]);
    }

    #[test]
    fn diff_creates_keyspace_and_missing_schema() {
        let config = test_config(THREE_HOSTS, Some(NTS));
        let diff = create_diff(&ExistingSchema::default(), "fluxer", &config).unwrap();
        assert_eq!(
            diff.statements[0],
            format!("CREATE KEYSPACE IF NOT EXISTS fluxer WITH replication = {NTS}")
        );
        assert!(!render_diff(&diff).contains("SimpleStrategy"));
        assert!(
            diff.statements
                .iter()
                .any(|statement| statement.starts_with("CREATE TYPE IF NOT EXISTS fluxer."))
        );
        assert!(
            diff.statements
                .iter()
                .any(|statement| statement.starts_with("CREATE TABLE IF NOT EXISTS fluxer."))
        );
        assert!(diff.errors.is_empty());
    }

    #[test]
    fn diff_reports_type_mismatches_and_extra_tables() {
        let mut existing = ExistingSchema {
            keyspace_exists: true,
            ..ExistingSchema::default()
        };
        existing.types.insert(
            "message_attachment".to_owned(),
            BTreeMap::from([("attachment_id".to_owned(), "text".to_owned())]),
        );
        existing
            .tables
            .insert("unexpected".to_owned(), ExistingTable::default());
        let diff = create_diff(&existing, "fluxer", &test_config("", None)).unwrap();
        assert!(
            diff.errors
                .iter()
                .any(|error| error.contains("type message_attachment.attachment_id"))
        );
        assert!(
            diff.warnings
                .iter()
                .any(|warning| warning.contains("unexpected"))
        );
    }

    #[test]
    fn render_diff_includes_warnings_errors_and_sha() {
        let diff = SchemaDiff {
            statements: vec!["SELECT 1".to_owned()],
            warnings: vec!["warn".to_owned()],
            errors: vec!["err".to_owned()],
            target_sha256: "abc".to_owned(),
        };
        let rendered = render_diff(&diff);
        assert!(rendered.contains("-- Target schema sha256: abc"));
        assert!(rendered.contains("--   warn"));
        assert!(rendered.contains("--   err"));
        assert!(rendered.ends_with("SELECT 1;\n"));
    }
}
