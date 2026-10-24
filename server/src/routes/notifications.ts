import type { Express } from 'express';
import { audit } from '../core/logger.ts';
import { bad, notFound } from '../core/errors.ts';
import {
  deleteNotificationChannel,
  listNotificationChannels,
  saveNotificationChannel,
  testNotificationChannel,
  type NotificationChannelInput,
} from '../services/notificationService.ts';

function inputBody(value: unknown): NotificationChannelInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('通知渠道内容格式无效');
  return value as NotificationChannelInput;
}

export function registerNotificationRoutes(app: Express): void {
  app.get('/api/notifications/channels', (_req, res) => {
    res.json({ channels: listNotificationChannels() });
  });

  app.post('/api/notifications/channels', (req, res) => {
    try {
      const channel = saveNotificationChannel(inputBody(req.body));
      audit({ ip: req.ip, action: 'notification.create', target: channel.provider });
      res.status(201).json({ channel });
    } catch (error) {
      throw bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.put('/api/notifications/channels/:id', (req, res) => {
    try {
      const channel = saveNotificationChannel({ ...inputBody(req.body), id: req.params.id });
      audit({ ip: req.ip, action: 'notification.update', target: channel.provider });
      res.json({ channel });
    } catch (error) {
      throw bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.delete('/api/notifications/channels/:id', (req, res) => {
    if (!deleteNotificationChannel(req.params.id)) throw notFound('通知渠道不存在');
    audit({ ip: req.ip, action: 'notification.delete', target: req.params.id });
    res.json({ ok: true });
  });

  app.post('/api/notifications/channels/:id/test', async (req, res) => {
    try {
      await testNotificationChannel(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ error: { code: 'NOTIFICATION_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
  });
}

