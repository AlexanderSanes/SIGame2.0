import express from 'express';
import * as packs from '../packs.js';

// Роутер монтируется ДО глобального express.json(): у импорта свой парсер с большим лимитом
const smallJson = express.json({ limit: '1mb' });
const importJson = express.json({ limit: '150mb' }); // base64 медиа внутри JSON

export function createPacksRouter() {
  const router = express.Router();

  router.get('/api/packs', (_req, res) => {
    res.json({ ok: true, packs: packs.listPacks() });
  });

  router.post('/api/packs', smallJson, (req, res) => {
    const check = packs.validatePack({ title: req.body?.title, rounds: req.body?.rounds });
    if (!check.ok) return res.status(400).json({ ok: false, errors: check.errors });
    if (packs.titleTaken(check.data.title)) {
      return res.status(400).json({ ok: false, errors: [{ path: 'title', label: 'Пакет', message: 'Пакет с таким названием уже существует' }] });
    }
    res.json({ ok: true, pack: packs.createPack(check.data) });
  });

  router.get('/api/packs/:id', (req, res) => {
    const pack = packs.getPack(req.params.id);
    if (!pack) return res.status(404).json({ ok: false, error: 'Пакет не найден' });
    res.json({ ok: true, pack });
  });

  router.put('/api/packs/:id', smallJson, (req, res) => {
    if (!packs.getPack(req.params.id)) {
      return res.status(404).json({ ok: false, error: 'Пакет не найден' });
    }
    const check = packs.validatePack({ title: req.body?.title, rounds: req.body?.rounds });
    if (!check.ok) return res.status(400).json({ ok: false, errors: check.errors });
    if (packs.titleTaken(check.data.title, req.params.id)) {
      return res.status(400).json({ ok: false, errors: [{ path: 'title', label: 'Пакет', message: 'Пакет с таким названием уже существует' }] });
    }
    res.json({ ok: true, pack: packs.savePack(req.params.id, check.data) });
  });

  router.delete('/api/packs/:id', (req, res) => {
    if (!packs.deletePack(req.params.id)) {
      return res.status(404).json({ ok: false, error: 'Пакет не найден' });
    }
    res.json({ ok: true });
  });

  router.post('/api/packs/:id/duplicate', (req, res) => {
    const pack = packs.duplicatePack(req.params.id);
    if (!pack) return res.status(404).json({ ok: false, error: 'Пакет не найден' });
    res.json({ ok: true, pack });
  });

  router.get('/api/packs/:id/export', (req, res) => {
    const data = packs.exportPack(req.params.id);
    if (!data) return res.status(404).json({ ok: false, error: 'Пакет не найден' });
    const name = encodeURIComponent(data.title.replace(/[^\wа-яё -]/gi, '').trim() || 'pack');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${name}.sigame.json`);
    res.json(data);
  });

  router.post('/api/packs/import', importJson, (req, res) => {
    const result = packs.importPack(req.body);
    if (!result.ok) return res.status(400).json({ ok: false, errors: result.errors });
    res.json({ ok: true, pack: result.pack });
  });

  return router;
}
