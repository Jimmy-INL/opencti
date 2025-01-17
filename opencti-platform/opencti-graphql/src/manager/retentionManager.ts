import moment, { type Moment } from 'moment';
import { findAll as findRetentionRulesToExecute } from '../domain/retentionRule';
import conf, { booleanConf, logApp } from '../config/conf';
import { deleteElementById, patchAttribute } from '../database/middleware';
import { executionContext, RETENTION_MANAGER_USER } from '../utils/access';
import { ENTITY_TYPE_RETENTION_RULE } from '../schema/internalObject';
import { now, utcDate } from '../utils/format';
import { READ_STIX_INDICES } from '../database/utils';
import { elPaginate } from '../database/engine';
import { convertFiltersToQueryOptions } from '../utils/filtering/filtering-resolution';
import type { ManagerDefinition } from './managerModule';
import { registerManager } from './managerModule';
import type { AuthContext } from '../types/user';
import type { FileEdge, RetentionRule } from '../generated/graphql';
import { deleteFile } from '../database/file-storage';
import { paginatedForPathWithEnrichment } from '../modules/internal/document/document-domain';

const RETENTION_MANAGER_ENABLED = booleanConf('retention_manager:enabled', false);
const RETENTION_MANAGER_START_ENABLED = booleanConf('retention_manager:enabled', true);
// Retention manager responsible to cleanup old data
// Each API will start is retention manager.
// If the lock is free, every API as the right to take it.
const SCHEDULE_TIME = conf.get('retention_manager:interval') || 60000;
const RETENTION_MANAGER_KEY = conf.get('retention_manager:lock_key') || 'retention_manager_lock';
const RETENTION_BATCH_SIZE = conf.get('retention_manager:batch_size') || 100;

export const deleteElement = async (context: AuthContext, scope: string, nodeId: string, nodeEntityType?: string) => {
  if (scope === 'knowledge') {
    await deleteElementById(context, RETENTION_MANAGER_USER, nodeId, nodeEntityType, { forceDelete: true });
  } else if (scope === 'file' || scope === 'workbench') {
    await deleteFile(context, RETENTION_MANAGER_USER, nodeId);
  } else {
    throw Error(`[Retention manager] Scope ${scope} not existing for Retention Rule.`);
  }
};

export const getElementsToDelete = async (context: AuthContext, scope: string, before: Moment, filters?: string) => {
  let result;
  if (scope === 'knowledge') {
    const jsonFilters = filters ? JSON.parse(filters) : null;
    const queryOptions = await convertFiltersToQueryOptions(jsonFilters, { before });
    result = await elPaginate(context, RETENTION_MANAGER_USER, READ_STIX_INDICES, { ...queryOptions, first: RETENTION_BATCH_SIZE });
  } else if (scope === 'file') {
    result = await paginatedForPathWithEnrichment(
      context,
      RETENTION_MANAGER_USER,
      'import/global',
      undefined,
      { first: RETENTION_BATCH_SIZE, notModifiedSince: before.toISOString() }
    );
  } else if (scope === 'workbench') {
    result = await paginatedForPathWithEnrichment(
      context,
      RETENTION_MANAGER_USER,
      'import/pending',
      undefined,
      { first: RETENTION_BATCH_SIZE, notModifiedSince: before.toISOString() }
    );
  } else {
    throw Error(`[Retention manager] Scope ${scope} not existing for Retention Rule.`);
  }
  if (scope === 'file' || scope === 'knowledge') { // don't delete files with ongoing works or incomplete status
    const resultEdges = result.edges.filter((e: FileEdge) => e.node.uploadStatus === 'complete'
      && (e.node.works ?? []).every((work) => work?.status === 'complete'));
    result.edges = resultEdges;
  }
  return result;
};

const executeProcessing = async (context: AuthContext, retentionRule: RetentionRule) => {
  const { id, name, max_retention: maxNumber, retention_unit: unit, filters, scope } = retentionRule;
  logApp.debug(`[OPENCTI] Executing retention manager rule ${name}`);
  const before = utcDate().subtract(maxNumber, unit ?? 'days');
  const result = await getElementsToDelete(context, scope, before, filters);
  const remainingDeletions = result.pageInfo.globalCount;
  const elements = result.edges;
  logApp.debug(`[OPENCTI] Retention manager clearing ${elements.length} elements`);
  for (let index = 0; index < elements.length; index += 1) {
    const { node } = elements[index];
    const { updated_at: up } = node;
    const humanDuration = moment.duration(utcDate(up).diff(utcDate())).humanize();
    try {
      await deleteElement(context, scope, scope === 'knowledge' ? node.internal_id : node.id, node.entity_type);
      logApp.debug(`[OPENCTI] Retention manager deleting ${node.id} after ${humanDuration}`);
    } catch (e) {
      logApp.error(e, { id: node.id, manager: 'RETENTION_MANAGER' });
    }
  }
  // Patch the last execution of the rule
  const patch = {
    last_execution_date: now(),
    remaining_count: remainingDeletions,
    last_deleted_count: elements.length,
  };
  await patchAttribute(context, RETENTION_MANAGER_USER, id, ENTITY_TYPE_RETENTION_RULE, patch);
};

const retentionHandler = async (lock: { signal: AbortSignal, extend: () => Promise<void>, unlock: () => Promise<void> }) => {
  const context = executionContext('retention_manager');
  const retentionRules = await findRetentionRulesToExecute(context, RETENTION_MANAGER_USER, { connectionFormat: false });
  logApp.debug(`[OPENCTI] Retention manager execution for ${retentionRules.length} rules`);
  // Execution of retention rules
  if (retentionRules.length > 0) {
    for (let index = 0; index < retentionRules.length; index += 1) {
      lock.signal.throwIfAborted();
      const retentionRule = retentionRules[index];
      await executeProcessing(context, retentionRule as unknown as RetentionRule);
    }
  }
};

const RETENTION_MANAGER_DEFINITION: ManagerDefinition = {
  id: 'RETENTION_MANAGER',
  label: 'Retention manager',
  executionContext: 'retention_manager',
  cronSchedulerHandler: {
    handler: retentionHandler,
    interval: SCHEDULE_TIME,
    lockKey: RETENTION_MANAGER_KEY,
    lockInHandlerParams: true,
  },
  enabledByConfig: RETENTION_MANAGER_ENABLED,
  enabledToStart(): boolean {
    return RETENTION_MANAGER_START_ENABLED;
  },
  enabled(): boolean {
    return this.enabledByConfig;
  }
};

registerManager(RETENTION_MANAGER_DEFINITION);
