'use strict';
const postgres = require('./postgres');
const mysql = require('./mysql');

const ENGINES = { postgres, mysql };

/** map ชื่อ alias → engine key */
const ALIAS = {
  postgres: 'postgres', postgresql: 'postgres', pg: 'postgres', postgre: 'postgres',
  mysql: 'mysql', mariadb: 'mysql', maria: 'mysql'
};

function normalizeEngine(e) {
  return ALIAS[String(e || 'postgres').toLowerCase()] || 'postgres';
}

function getEngine(e) {
  return ENGINES[normalizeEngine(e)];
}

function listEngines() {
  return Object.values(ENGINES).map(e => ({ name: e.name, label: e.label, defaultPort: e.defaultPort }));
}

module.exports = { getEngine, normalizeEngine, listEngines, ENGINES };
