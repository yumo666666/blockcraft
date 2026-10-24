import type { Express } from 'express';
import { INSTANCE_ID_RE } from '../core/paths.ts';
import { bad, notFound } from '../core/errors.ts';
import * as I from '../services/instanceService.ts';
import {
  PERFORMANCE_METRICS,
  PERFORMANCE_RETENTION_MS,
  PERFORMANCE_SAMPLE_INTERVAL_MS,
  readPerformanceHistory,
  type PerformanceMetric,
} from '../services/performanceHistory.ts';

const METRIC_KEYS = new Set(Object.keys(PERFORMANCE_METRICS));

export function registerPerformanceRoutes(app: Express): void {
  app.get('/api/instances/:id/performance/:metric', async (req, res) => {
    const id = req.params.id;
    const metric = req.params.metric;
    if (!INSTANCE_ID_RE.test(id)) throw bad('世界 id 不合法');
    if (!I.exists(id)) throw notFound(`世界不存在：${id}`);
    if (!METRIC_KEYS.has(metric)) throw notFound(`没有这个性能指标：${metric}`);

    const now = Date.now();
    const fromValue = req.query.from === undefined ? now - 60 * 60 * 1000 : Number(req.query.from);
    const toValue = req.query.to === undefined ? now : Number(req.query.to);
    if (!Number.isSafeInteger(fromValue) || !Number.isSafeInteger(toValue) || toValue <= fromValue) {
      throw bad('性能历史时间范围无效');
    }

    const config = I.getConfig(id);
    const range = await readPerformanceHistory(id, metric as PerformanceMetric, fromValue, toValue, now);
    res.json({
      world: { id, name: config.name, maxPlayers: config.maxPlayers },
      metric: {
        key: metric,
        title: PERFORMANCE_METRICS[metric as PerformanceMetric].title,
        unit: PERFORMANCE_METRICS[metric as PerformanceMetric].unit,
        description: PERFORMANCE_METRICS[metric as PerformanceMetric].description,
        source: PERFORMANCE_METRICS[metric as PerformanceMetric].source,
      },
      ...range,
      sampleIntervalMs: PERFORMANCE_SAMPLE_INTERVAL_MS,
      retentionMs: PERFORMANCE_RETENTION_MS,
      maxPoints: 2200,
    });
  });
}
