// ═══════════════════════════════════════════════════════════════════
//  Hamburger Heimat Bank  ·  Management Bot  ·  discord.js v14
//  Einzel-Datei: index.js  ·  Datenbank: backup.json
//  Components V2 Edition
// ═══════════════════════════════════════════════════════════════════
'use strict';

const {
  Client, GatewayIntentBits, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, AttachmentBuilder, EmbedBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder,
  MediaGalleryItemBuilder, MessageFlags,
  ComponentType,
} = require('discord.js');

const fs      = require('fs');
const path    = require('path');
const express = require('express');

// ────────────────────────────────────────────────────────────────────
//  KONFIGURATION
// ────────────────────────────────────────────────────────────────────
const ADMIN_IDS = ['1211683189186105434', '638734639057338387'];
const TOKEN     = process.env.BOT_TOKEN;
const DB_FILE   = path.resolve('backup.json');

const FOOTER_TEXT = 'Copyright © Hamburger Heimat Bank';
const COLOR       = 0x393A41;
const CV2_FLAG    = 1 << 15;

// Schwellenwerte
const SHIFT_ANOMALIE_STUNDEN  = 10; // Stunden bis Warnung
const URLAUB_ERINNERUNG_STUNDEN = 24; // Stunden vor Urlaubsende → DM

const MONATE_DE = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

// ────────────────────────────────────────────────────────────────────
//  STATUS-HILFSFUNKTIONEN
// ────────────────────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    aktiv:      'Aktiv',
    inaktiv:    'Inaktiv',
    pausiert:   'Pausiert',
    beendet:    'Beendet',
    ausstehend: 'Ausstehend',
    genehmigt:  'Genehmigt',
    abgelehnt:  'Abgelehnt',
  };
  return `> **${map[status] ?? status}**`;
}

function formatDauer(dauer) {
  if (!dauer) return dauer ?? '?';
  const raw = String(dauer).toLowerCase().trim();
  const n   = parseInt(raw);
  if (isNaN(n) || n <= 0) return dauer;
  if (raw.endsWith('d')) return `${n} ${n === 1 ? 'Tag'   : 'Tage'}`;
  if (raw.endsWith('w')) return `${n} ${n === 1 ? 'Woche' : 'Wochen'}`;
  if (raw.endsWith('m')) return `${n} ${n === 1 ? 'Monat' : 'Monate'}`;
  return dauer;
}

// ────────────────────────────────────────────────────────────────────
//  DATENBANK
// ────────────────────────────────────────────────────────────────────
const DEFAULT_DB = {
  config: {
    rollen:  { leitungsebene: [], mitarbeiter: [] },
    kanaele: {
      panel: null, dokumentationen: null,
      urlaubsantraege: null, backup: null, monatliches_panel: null,
    },
    panel_nachricht_id:  null,
    letztes_monatspanel: null,
  },
  shifts:  {},
  users:   {},
  salary:  { rollen: {} },
  leave:   {},
  // Gesendete Erinnerungen tracken (Urlaubs-Ende, Shift-Anomalie)
  notified: { urlaub_ende: {}, shift_anomalie: {} },
};

function loadDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Migration: notified-Feld ergänzen falls nicht vorhanden
    if (!db.notified) db.notified = { urlaub_ende: {}, shift_anomalie: {} };
    if (!db.notified.urlaub_ende)   db.notified.urlaub_ende   = {};
    if (!db.notified.shift_anomalie) db.notified.shift_anomalie = {};
    return db;
  } catch {
    const db = JSON.parse(JSON.stringify(DEFAULT_DB));
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    return db;
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function ensureUser(db, uid) {
  if (!db.users[uid]) {
    db.users[uid] = {
      gesamt_shift_sekunden: 0,
      shift_anzahl:          0,
      tickets:               0,
      urlaubstage:           0,
      benutzername:          '',
    };
  }
}

// ────────────────────────────────────────────────────────────────────
//  BERECHTIGUNGEN
// ────────────────────────────────────────────────────────────────────
const isAdmin = (uid) => ADMIN_IDS.includes(String(uid));

function isLeitungsebene(member) {
  if (isAdmin(member.id)) return true;
  const ids = loadDB().config.rollen.leitungsebene;
  return member.roles.cache.some(r => ids.includes(String(r.id)));
}

function isMitarbeiter(member) {
  if (isLeitungsebene(member)) return true;
  const ids = loadDB().config.rollen.mitarbeiter;
  return member.roles.cache.some(r => ids.includes(String(r.id)));
}

// ────────────────────────────────────────────────────────────────────
//  URLAUB-HILFSFUNKTIONEN
// ────────────────────────────────────────────────────────────────────

/** Gibt true zurück wenn der User einen aktiven oder ausstehenden Urlaub hat */
function hatAktivenOderAusstehendUrlaub(db, uid) {
  const now = nowTs();
  // Aktiver Urlaub
  const aktiv = (db.leave[uid]?.aktiv ?? []).some(a => (a.end_zeitstempel ?? 0) > now);
  if (aktiv) return 'aktiv';
  // Ausstehender Antrag
  const ausstehend = (db.leave[uid]?.eintraege ?? []).some(e => e.status === 'ausstehend');
  if (ausstehend) return 'ausstehend';
  return null;
}

// ────────────────────────────────────────────────────────────────────
//  ZEIT-HILFSFUNKTIONEN
// ────────────────────────────────────────────────────────────────────
function nowTs() { return Math.floor(Date.now() / 1000); }
function tsDisc(ts, fmt = 'F') { return `<t:${Math.floor(ts)}:${fmt}>`; }

function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const p = [];
  if (h) p.push(`${h} ${h === 1 ? 'Stunde' : 'Stunden'}`);
  if (m) p.push(`${m} ${m === 1 ? 'Minute' : 'Minuten'}`);
  if (s || !p.length) p.push(`${s} ${s === 1 ? 'Sekunde' : 'Sekunden'}`);
  return p.join(', ');
}

function fmtHours(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatRelative(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const y  = Math.floor(seconds / (365 * 86400)); seconds %= 365 * 86400;
  const mo = Math.floor(seconds / (30  * 86400)); seconds %= 30  * 86400;
  const w  = Math.floor(seconds / (7   * 86400)); seconds %= 7   * 86400;
  const d  = Math.floor(seconds / 86400);         seconds %= 86400;
  const h  = Math.floor(seconds / 3600);          seconds %= 3600;
  const mi = Math.floor(seconds / 60);
  const p  = [];
  if (y)  p.push(`${y} ${y  === 1 ? 'Jahr' : 'Jahre'}`);
  if (mo) p.push(`${mo} ${mo === 1 ? 'Monat' : 'Monate'}`);
  if (w)  p.push(`${w} ${w  === 1 ? 'Woche' : 'Wochen'}`);
  if (d)  p.push(`${d} ${d  === 1 ? 'Tag' : 'Tage'}`);
  if (!p.length) {
    if (h)  p.push(`${h} ${h  === 1 ? 'Stunde' : 'Stunden'}`);
    if (mi) p.push(`${mi} ${mi === 1 ? 'Minute' : 'Minuten'}`);
  }
  return p.join(', ') || 'weniger als eine Minute';
}

function dauerZuSekunden(dauer) {
  dauer = dauer.toLowerCase().trim();
  const n = parseInt(dauer);
  if (!isNaN(n)) {
    if (dauer.endsWith('d')) return n * 86400;
    if (dauer.endsWith('w')) return n * 7 * 86400;
    if (dauer.endsWith('m')) return n * 30 * 86400;
  }
  return 86400;
}

const dauerZuTage = (d) => Math.floor(dauerZuSekunden(d) / 86400);

function parseZeitEingabe(raw) {
  raw = raw.trim();
  if (!raw) throw new Error('Leere Eingabe');
  let modus = '+';
  let rest  = raw;
  if (['+', '-', '='].includes(raw[0])) { modus = raw[0]; rest = raw.slice(1); }
  if (!rest.includes(':')) throw new Error("Kein ':' gefunden — bitte HH:MM verwenden");
  const [hStr, mStr] = rest.split(':');
  const h = parseInt(hStr), m = parseInt(mStr);
  if (isNaN(h) || isNaN(m))    throw new Error('Ungültige Zahlen');
  if (m < 0 || m >= 60)        throw new Error('Minuten müssen zwischen 0 und 59 liegen');
  if (h < 0)                   throw new Error('Stunden dürfen nicht negativ sein');
  return { modus, sekunden: h * 3600 + m * 60 };
}

function datumDe(ts) {
  return new Date(ts * 1000).toLocaleDateString('de-DE', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ────────────────────────────────────────────────────────────────────
//  COMPONENTS V2 HILFSFUNKTIONEN
// ────────────────────────────────────────────────────────────────────
function makeSeparator(spacing = 1) {
  return new SeparatorBuilder().setSpacing(spacing).setDivider(true);
}

function makeText(content) {
  return new TextDisplayBuilder().setContent(content);
}

function makeRow(...buttons) {
  return new ActionRowBuilder().addComponents(...buttons);
}

// ────────────────────────────────────────────────────────────────────
//  SHIFT-HILFSFUNKTIONEN
// ────────────────────────────────────────────────────────────────────
function aktuelleShiftSekunden(shift) {
  if (shift?.status === 'aktiv' && shift?.start_zeit) {
    return (shift.gespeicherte_sekunden ?? 0)
      + (Date.now() / 1000 - shift.start_zeit)
      - (shift.gesamt_pause_sekunden ?? 0);
  }
  return shift?.gespeicherte_sekunden ?? 0;
}

function durchschnitt(userData) {
  const cnt = userData.shift_anzahl ?? 0;
  return cnt > 0 ? (userData.gesamt_shift_sekunden ?? 0) / cnt : 0;
}

// Status-Button-Konfiguration für Shift-Container
function shiftStatusButton(status, uid) {
  const map = {
    aktiv:    { label: 'Aktiv',    style: ButtonStyle.Success   },
    pausiert: { label: 'Pausiert', style: ButtonStyle.Primary   },
    inaktiv:  { label: 'Inaktiv',  style: ButtonStyle.Secondary },
    beendet:  { label: 'Beendet',  style: ButtonStyle.Danger    },
  };
  const cfg = map[status] ?? { label: status, style: ButtonStyle.Secondary };
  return new ButtonBuilder()
    .setCustomId(`shift_status_noop_${status}_${uid}_${Date.now()}`)
    .setLabel(cfg.label)
    .setStyle(cfg.style)
    .setDisabled(true);
}

function buildShiftContainer(member, status, db, extraText = null) {
  const uid   = String(member.id);
  ensureUser(db, uid);
  const nd    = db.users[uid];
  const aktiv = db.shifts[uid];

  let anzeige = nd.gesamt_shift_sekunden;
  if (aktiv && ['aktiv', 'pausiert'].includes(status)) {
    anzeige += aktuelleShiftSekunden(aktiv);
  }

  // Laufzeit + Startzeit-Spanne anzeigen
  let laufzeitLine = '';
  if (aktiv && status === 'aktiv') {
    const laufSek  = aktuelleShiftSekunden(aktiv);
    const effStart = Math.floor(Date.now() / 1000 - laufSek);
    laufzeitLine   = `\n> **Gestartet:** ${tsDisc(effStart, 't')} (${tsDisc(effStart, 'R')})`;
    if (laufSek > SHIFT_ANOMALIE_STUNDEN * 3600) {
      laufzeitLine += `\n> **Shift läuft seit über ${SHIFT_ANOMALIE_STUNDEN} Stunden!**`;
    }
  } else if (aktiv && status === 'pausiert') {
    const laufSek  = aktuelleShiftSekunden(aktiv);
    const effStart = Math.floor(Date.now() / 1000 - laufSek);
    laufzeitLine   = `\n> **Gestartet:** ${tsDisc(effStart, 't')}\n> **Pausiert seit:** ${tsDisc(aktiv.pause_start ?? nowTs(), 'R')}`;
  }

  const startAkt = ['inaktiv', 'pausiert'].includes(status);
  const pauseAkt = status === 'aktiv';
  const endAkt   = status === 'aktiv';
  const alleAus  = status === 'beendet';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sv_start_${uid}`).setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(!startAkt || alleAus),
    new ButtonBuilder().setCustomId(`sv_pause_${uid}`).setLabel('Pause').setStyle(ButtonStyle.Primary).setDisabled(!pauseAkt || alleAus),
    new ButtonBuilder().setCustomId(`sv_end_${uid}`).setLabel('Beenden').setStyle(ButtonStyle.Danger).setDisabled(!endAkt || alleAus),
  );

  const container = new ContainerBuilder()
    // Header-Section: Titel links, Status-Button rechts
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(makeText(`## Shift Management — <@${uid}>`))
        .setButtonAccessory(shiftStatusButton(status, uid))
    )
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(
      makeText(
        `> **Schichten:** \`${nd.shift_anzahl}\`\n`
        + `> **Gesamtdauer:** \`${formatDuration(anzeige)}\`\n`
        + `> **Durchschnitt:** \`${formatDuration(durchschnitt(nd))}\``
        + laufzeitLine
      )
    )
    .addSeparatorComponents(makeSeparator());

  if (extraText) {
    container.addTextDisplayComponents(makeText(extraText));
    container.addSeparatorComponents(makeSeparator());
  }

  container
    .addActionRowComponents(row)
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

  return { components: [container], flags: CV2_FLAG };
}

function buildShiftAdminContainer(member, db) {
  const uid    = String(member.id);
  ensureUser(db, uid);
  const nd     = db.users[uid];
  const aktiv  = db.shifts[uid];
  const anz    = (nd.gesamt_shift_sekunden ?? 0) + (aktiv ? aktuelleShiftSekunden(aktiv) : 0);
  const stat   = aktiv?.status ?? 'inaktiv';

  let aktivLine = '';
  if (aktiv) {
    const laufSek  = aktuelleShiftSekunden(aktiv);
    const effStart = Math.floor(Date.now() / 1000 - laufSek);
    aktivLine = `\n> **Aktive Shift:** \`${formatDuration(laufSek)}\` (seit ${tsDisc(effStart, 't')})`;
    if (laufSek > SHIFT_ANOMALIE_STUNDEN * 3600) {
      aktivLine += `\n> **Über ${SHIFT_ANOMALIE_STUNDEN}h aktiv!**`;
    }
  }

  const rows = buildShiftAdminRows(String(member.id));

  const container = new ContainerBuilder()
    // Header-Section: Titel links, Status-Button rechts
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(makeText(`## Schicht-Admin — <@${uid}>`))
        .setButtonAccessory(shiftStatusButton(stat, uid))
    )
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(
      makeText(
        `> **Schichten:** \`${nd.shift_anzahl}\`\n`
        + `> **Gesamt:** \`${formatDuration(anz)}\`\n`
        + `> **Durchschnitt:** \`${formatDuration(durchschnitt(nd))}\``
        + aktivLine
      )
    )
    .addSeparatorComponents(makeSeparator());

  for (const row of rows) container.addActionRowComponents(row);
  container.addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

  return { components: [container], flags: CV2_FLAG };
}

function buildShiftAdminRows(uid) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sa_start_${uid}`).setLabel('Start').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sa_pause_${uid}`).setLabel('Pause').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`sa_end_${uid}`).setLabel('Beenden').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sa_edit_${uid}`).setLabel('Zeit anpassen').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sa_del_${uid}`).setLabel('Shift löschen').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`sa_clear_${uid}`).setLabel('Alle Daten löschen').setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ────────────────────────────────────────────────────────────────────
//  GEHALT-HILFSFUNKTIONEN
// ────────────────────────────────────────────────────────────────────
function gehaltBerechnen(member, userData, db) {
  const rc = db.salary.rollen ?? {};
  let shiftRate = 0, ticketRate = 0, mindestStd = 0;

  for (const role of member.roles.cache.values()) {
    const rid = String(role.id);
    if (rc[rid]) {
      shiftRate  = Math.max(shiftRate,  parseFloat(rc[rid].shift_pro_stunde      ?? 0));
      ticketRate = Math.max(ticketRate, parseFloat(rc[rid].ticket_bonus           ?? 0));
      mindestStd = Math.max(mindestStd, parseFloat(rc[rid].mindest_shift_stunden ?? 0));
    }
  }

  const shiftSek = userData.gesamt_shift_sekunden ?? 0;
  const tickets  = userData.tickets ?? 0;
  const stunden  = Math.floor(shiftSek / 3600);
  const shiftG   = Math.round(stunden  * shiftRate  * 100) / 100;
  const tickG    = Math.round(tickets  * ticketRate  * 100) / 100;

  return {
    shift_sekunden:   shiftSek,
    shift_stunden:    stunden,
    tickets,
    shift_gehalt:     shiftG,
    ticket_gehalt:    tickG,
    gesamt_gehalt:    Math.round((shiftG + tickG) * 100) / 100,
    shift_rate:       shiftRate,
    ticket_rate:      ticketRate,
    mindest_stunden:  mindestStd,
    mindest_erfuellt: mindestStd <= 0 || stunden >= mindestStd,
  };
}

function buildGehaltContainer(guild, member, d) {
  const mindestErreicht = d.mindest_stunden > 0 ? d.mindest_erfuellt : null;

  let headerSection;
  if (mindestErreicht !== null) {
    const btnLabel = mindestErreicht
      ? 'Mindestshift erfüllt'
      : 'Mindestshift fehlt';
    const btnStyle = mindestErreicht ? ButtonStyle.Success : ButtonStyle.Danger;

    headerSection = new SectionBuilder()
      .addTextDisplayComponents(makeText('## Gehaltsübersicht'))
      .setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`gehalt_status_noop_${Date.now()}`)
          .setLabel(btnLabel)
          .setStyle(btnStyle)
          .setDisabled(true)
      );
  }

  const mindestLine = d.mindest_stunden > 0
    ? `> **Mindestshift:** \`${d.shift_stunden}h\` von \`${d.mindest_stunden}h\`\n`
    : '';

  const container = new ContainerBuilder();

  if (headerSection) {
    container.addSectionComponents(headerSection);
  } else {
    container.addTextDisplayComponents(makeText('## Gehaltsübersicht'));
  }

  container
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(`> **Mitarbeiter:** <@${member.id}>`))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(
      makeText(
        `**Übersicht Shift**\n`
        + `> **Erreichte Shift:** ${formatDuration(d.shift_sekunden)}\n`
        + `> **Gehalt:** ${d.shift_rate.toFixed(2)} € / Stunde\n`
        + mindestLine
        + `> **Zwischensumme:** **${d.shift_gehalt.toFixed(2)} €**`
      )
    )
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(
      makeText(
        `**Übersicht Tickets**\n`
        + `> **Erreichte Tickets:** \`${d.tickets}\`\n`
        + `> **Gehalt:** ${d.ticket_rate.toFixed(2)} € / Ticket\n`
        + `> **Zwischensumme:** **${d.ticket_gehalt.toFixed(2)} €**`
      )
    )
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(`> **Gesamtgehalt: ${d.gesamt_gehalt.toFixed(2)} €**`))
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

  return { components: [container], flags: CV2_FLAG };
}

// ────────────────────────────────────────────────────────────────────
//  DM-NACHRICHTEN (Urlaub) — Components V2
// ────────────────────────────────────────────────────────────────────
async function dmSend(member, components) {
  try { await member.send({ components, flags: CV2_FLAG }); } catch {}
}

function dmStatusSection(titel, statusKey) {
  const map = {
    ausstehend: { label: 'Ausstehend', style: ButtonStyle.Secondary },
    genehmigt:  { label: 'Genehmigt',  style: ButtonStyle.Success   },
    abgelehnt:  { label: 'Abgelehnt',  style: ButtonStyle.Danger    },
    beendet:    { label: 'Beendet',    style: ButtonStyle.Secondary },
    erinnerung: { label: 'Erinnerung', style: ButtonStyle.Primary   },
    warnung:    { label: 'Warnung',    style: ButtonStyle.Danger    },
  };
  const cfg = map[statusKey] ?? { label: statusKey, style: ButtonStyle.Secondary };
  return new SectionBuilder()
    .addTextDisplayComponents(makeText(`## ${titel}`))
    .setButtonAccessory(
      new ButtonBuilder()
        .setCustomId(`dm_status_noop_${statusKey}_${Date.now()}`)
        .setLabel(cfg.label)
        .setStyle(cfg.style)
        .setDisabled(true)
    );
}

function dmContainerAusstehend(endTs) {
  return [new ContainerBuilder()
    .addSectionComponents(dmStatusSection('Urlaubsantrag', 'ausstehend'))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(
      `> Dein Urlaubsantrag wurde zur Genehmigung weitergeleitet.\n`
      + `> Ende bei Genehmigung: ${tsDisc(endTs, 'F')}.\n`
      + `> Zum Einsehen: </leave manage:1477325994473033742>.`
    ))
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`))];
}

function dmContainerGenehmigt(endTs) {
  return [new ContainerBuilder()
    .addSectionComponents(dmStatusSection('Urlaubsantrag', 'genehmigt'))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(
      `> Dein Urlaubsantrag wurde genehmigt.\n`
      + `> Zum Einsehen: </leave manage:1477325994473033742>.\n\n`
      + `> Dein Urlaub endet am ${tsDisc(endTs, 'F')}.`
    ))
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`))];
}

function dmContainerAbgelehnt() {
  return [new ContainerBuilder()
    .addSectionComponents(dmStatusSection('Urlaubsantrag', 'abgelehnt'))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(
      `> Dein Urlaubsantrag wurde leider abgelehnt.\n`
      + `> Bei Fragen wende dich an die Leitungsebene.`
    ))
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`))];
}

function dmContainerBeendet(startTs) {
  return [new ContainerBuilder()
    .addSectionComponents(dmStatusSection('Urlaubsantrag', 'beendet'))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(
      `> Dein Urlaub, der am ${tsDisc(startTs, 'F')} `
      + `(vor ${formatRelative(nowTs() - startTs)}) begann, ist beendet.\n`
      + `> Willkommen zurück.`
    ))
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`))];
}

function dmContainerUrlaubEndeErinnerung(endTs) {
  return [new ContainerBuilder()
    .addSectionComponents(dmStatusSection('Urlaubserinnerung', 'erinnerung'))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(
      `> Dein Urlaub endet in weniger als **${URLAUB_ERINNERUNG_STUNDEN} Stunden**.\n`
      + `> Ende: ${tsDisc(endTs, 'F')} (${tsDisc(endTs, 'R')}).\n`
      + `> Bereite dich auf deine Rückkehr vor!`
    ))
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`))];
}

function dmContainerShiftAnomalie(uid, laufSek) {
  return [new ContainerBuilder()
    .addSectionComponents(dmStatusSection('Shift-Anomalie erkannt', 'warnung'))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(
      `> <@${uid}> hat eine aktive Schicht von **${formatDuration(laufSek)}**.\n`
      + `> Das überschreitet den Schwellenwert von **${SHIFT_ANOMALIE_STUNDEN} Stunden**.\n`
      + `> Bitte überprüfen: \`/shift admin\``
    ))
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`))];
}

const dmAusstehend = (guild, member, dauer, endTs) => dmSend(member, dmContainerAusstehend(endTs));
const dmGenehmigt  = (guild, member, dauer, endTs) => dmSend(member, dmContainerGenehmigt(endTs));
const dmAbgelehnt  = (guild, member)                => dmSend(member, dmContainerAbgelehnt());
const dmBeendet    = (guild, member, startTs)        => dmSend(member, dmContainerBeendet(startTs));

// ────────────────────────────────────────────────────────────────────
//  PANEL-EMBED (Dokumentation) — Components V2
// ────────────────────────────────────────────────────────────────────
async function panelEmbedSenden(channel) {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(makeText(
      `## Dokumentation\n`
      + `Klicke den Button unten um eine neue Dokumentation einzureichen.\n`
      + `> \`-\` Name des Tickets\n> \`-\` Worum ging es?\n> \`-\` Gab es Probleme?\n`
      + `__**Information zu Dokumentation**__\n`
      + `> Ihr müsst nun bei Einzahlungen den eingezahlten Betrag dokumentieren.`
      + `> Tragt dies bitte bei \`Worum ging es?\` ein. Diese Regelung gilt, um Betrug zu vermeiden.`
    ))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_erstellen').setLabel('Dokumentieren').setStyle(ButtonStyle.Danger),
  );

  const msg = await channel.send({ components: [container, row], flags: CV2_FLAG });
  const db  = loadDB();
  db.config.panel_nachricht_id = String(msg.id);
  saveDB(db);
  return msg;
}

// ────────────────────────────────────────────────────────────────────
//  BACKUP SENDEN
// ────────────────────────────────────────────────────────────────────
async function backupSenden(channel) {
  const db   = loadDB();
  const name = `backup.json`;
  const att  = new AttachmentBuilder(Buffer.from(JSON.stringify(db, null, 2), 'utf8'), { name });

  await channel.send({ files: [att] });

  const container = new ContainerBuilder()
    .addTextDisplayComponents(makeText(
      `## Automatisches Datenbank-Backup\n`
      + `Die Datenbankdatei wurde als JSON gesichert.`
    ))
    .addSeparatorComponents(makeSeparator())
    .addTextDisplayComponents(makeText(
      `> **Zeitpunkt:** ${tsDisc(nowTs(), 'F')}\n`
      + `> **Datei:** \`${name}\``
    ))
    .addTextDisplayComponents(makeText(`-# Nächstes Backup in 24 Stunden`));

  await channel.send({ components: [container], flags: CV2_FLAG });
  console.log(`[Backup] ${name} -> #${channel.name}`);
}

function backupAlsAttachment() {
  const db   = loadDB();
  return { att: new AttachmentBuilder(Buffer.from(JSON.stringify(db, null, 2), 'utf8'), { name: 'backup.json' }), name: 'backup.json' };
}

// ────────────────────────────────────────────────────────────────────
//  MONATLICHES PANEL
// ────────────────────────────────────────────────────────────────────
async function monatlichesPanelSenden(guild, channel) {
  const db       = loadDB();
  const rc       = db.salary.rollen ?? {};
  const jetzt    = new Date();
  const monatStr = `${MONATE_DE[jetzt.getUTCMonth()]} ${jetzt.getUTCFullYear()}`;

  const mitIds  = new Set(db.config.rollen.mitarbeiter);
  const leitIds = new Set(db.config.rollen.leitungsebene);
  const alleIds = new Set([...mitIds, ...leitIds]);

  const erfuellt      = [];
  const nichtErfuellt = [];

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (!member.roles.cache.some(r => alleIds.has(String(r.id)))) continue;

    const sortiertRollen = [...member.roles.cache.values()].sort((a, b) => b.position - a.position);
    let mindestSek = 0;
    for (const r of sortiertRollen) {
      const rid = String(r.id);
      if (rc[rid]) {
        const ms = parseFloat(rc[rid].mindest_shift_stunden ?? 0);
        if (ms > 0) { mindestSek = ms * 3600; break; }
      }
    }

    const uid      = String(member.id);
    const nd       = db.users[uid] ?? { gesamt_shift_sekunden: 0, tickets: 0 };
    const shiftSek = parseFloat(nd.gesamt_shift_sekunden ?? 0);
    const eintrag  = { uid, shift: shiftSek, tickets: nd.tickets ?? 0, mindestSek };

    if (mindestSek <= 0 || shiftSek >= mindestSek) erfuellt.push(eintrag);
    else nichtErfuellt.push(eintrag);
  }

  erfuellt.sort((a, b)      => b.shift - a.shift);
  nichtErfuellt.sort((a, b) => b.shift - a.shift);

  const fmtErfuellt = (u, i) =>
    `\`${i + 1}.\` <@${u.uid}> — **${fmtHours(u.shift)}**`;
  const fmtNicht = (u) =>
    `\`-\` <@${u.uid}> — **${fmtHours(u.shift)}** / \`${fmtHours(u.mindestSek)}\` benötigt`;

  const erfZeilen  = erfuellt.slice(0, 20).map((u, i) => fmtErfuellt(u, i)).join('\n')
    || 'Niemand hat die Mindestshift erreicht.';
  const nichtZeilen = nichtErfuellt.slice(0, 20).map(u => fmtNicht(u)).join('\n')
    || 'Alle Mitarbeiter haben die Mindestshift erfüllt.';

  const erfuelltExtra = erfuellt.length > 20 ? `\n... und ${erfuellt.length - 20} weitere` : '';
  const nichtExtra    = nichtErfuellt.length > 20 ? `\n... und ${nichtErfuellt.length - 20} weitere` : '';

  const gesamtAlleSek = [...erfuellt, ...nichtErfuellt].reduce((acc, u) => acc + u.shift, 0);
  const gesamtTickets = [...erfuellt, ...nichtErfuellt].reduce((acc, u) => acc + u.tickets, 0);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`Monatsübersicht — ${monatStr}`)
    .addFields(
      {
        name:  `Mindestshift erfüllt (${erfuellt.length})`,
        value: (erfZeilen + erfuelltExtra).slice(0, 1024),
      },
      {
        name:  `Mindestshift nicht erfüllt (${nichtErfuellt.length})`,
        value: (nichtZeilen + nichtExtra).slice(0, 1024),
      },
      {
        name:  'Team Statistiken',
        value: `> \`-\` Gesamt-Shiftstunden: **${fmtHours(gesamtAlleSek)}**\n> \`-\` Gesamt-Tickets: **${gesamtTickets}**\n> \`-\` Mitarbeiter erfasst: **${erfuellt.length + nichtErfuellt.length}**`,
      },
    )
    .setFooter({ text: FOOTER_TEXT });

  await channel.send({ embeds: [embed] });

  const db2 = loadDB();
  db2.config.letztes_monatspanel = nowTs();
  saveDB(db2);
  console.log(`[Monatspanel] Gesendet für ${monatStr} -> #${channel.name}`);
}

// ────────────────────────────────────────────────────────────────────
//  SLASH-COMMAND DEFINITIONEN
// ────────────────────────────────────────────────────────────────────
const COMMANDS = [
  new SlashCommandBuilder()
    .setName('shift').setDescription('Schichtverwaltung')
    .addSubcommand(s => s.setName('manage').setDescription('Öffnet deinen persönlichen Schicht-Manager'))
    .addSubcommand(s => s.setName('active').setDescription('Zeigt alle aktiven Schichten'))
    .addSubcommand(s => s.setName('leaderboard').setDescription('Zeigt das Schicht-Leaderboard'))
    .addSubcommand(s => s.setName('admin').setDescription('Admin-Schichtmanager für einen User')
      .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))),

  new SlashCommandBuilder()
    .setName('leave').setDescription('Urlaubsverwaltung')
    .addSubcommand(s => s.setName('manage').setDescription('Verwalte deinen Urlaub'))
    .addSubcommand(s => s.setName('active').setDescription('Zeigt alle aktiven Urlaubsabwesenheiten'))
    .addSubcommand(s => s.setName('admin').setDescription('Urlaubsverwaltung für einen User (Leitungsebene)')
      .addUserOption(o => o.setName('user').setDescription('Ziel-User').setRequired(true))),

  new SlashCommandBuilder()
    .setName('ticket').setDescription('Ticket-Verwaltung')
    .addSubcommand(s => s.setName('leaderboard').setDescription('Zeigt das Ticket-Leaderboard'))
    .addSubcommand(s => s.setName('admin').setDescription('Tickets für einen User anpassen')
      .addUserOption(o => o.setName('user').setDescription('Ziel-Mitarbeiter').setRequired(true))
      .addStringOption(o => o.setName('aktion').setDescription('Hinzufügen oder Entfernen').setRequired(true)
        .addChoices({ name: 'Hinzufügen', value: 'add' }, { name: 'Entfernen', value: 'remove' }))
      .addIntegerOption(o => o.setName('anzahl').setDescription('Anzahl').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('gehalt').setDescription('Gehalts-Verwaltung')
    .addSubcommand(s => s.setName('anzeigen').setDescription('Zeigt die Gehaltsübersicht')
      .addUserOption(o => o.setName('user').setDescription('(Optional) Anderer User').setRequired(false)))
    .addSubcommand(s => s.setName('konfigurieren').setDescription('Gehalt für Rolle festlegen (nur Admins)')
      .addStringOption(o => o.setName('kategorie').setDescription('Kategorie').setRequired(true)
        .addChoices({ name: 'Schicht (pro Stunde)', value: 'shift' }, { name: 'Ticket (pro Ticket)', value: 'ticket' }))
      .addRoleOption(o => o.setName('rolle').setDescription('Die Rolle').setRequired(true))
      .addNumberOption(o => o.setName('betrag').setDescription('Betrag in Euro').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s.setName('export').setDescription('Exportiert Gehaltsdaten als HTML-Dokument'))
    .addSubcommand(s => s.setName('reset').setDescription('Setzt alle Shift- und Ticket-Daten zurück (nur Admins)')),

  new SlashCommandBuilder()
    .setName('stats').setDescription('Persönliche Statistik-Übersicht')
    .addUserOption(o => o.setName('user').setDescription('(Optional) Anderer Mitarbeiter').setRequired(false)),

  new SlashCommandBuilder()
    .setName('urlaubskalender').setDescription('Zeigt alle aktiven und kommenden Urlaube als Timeline'),

  new SlashCommandBuilder()
    .setName('konfiguriere').setDescription('Bot-Konfiguration (nur Admins)')
    .addSubcommand(s => s.setName('rolle').setDescription('Setzt eine Rolle für eine Sicherheitsstufe')
      .addStringOption(o => o.setName('stufe').setDescription('Sicherheitsstufe').setRequired(true)
        .addChoices({ name: 'Leitungsebene', value: 'leitungsebene' }, { name: 'Mitarbeiter', value: 'mitarbeiter' }))
      .addRoleOption(o => o.setName('rolle').setDescription('Die Rolle').setRequired(true)))
    .addSubcommand(s => s.setName('kanal').setDescription('Setzt einen Kanal für eine Funktion')
      .addStringOption(o => o.setName('funktion').setDescription('Funktion').setRequired(true)
        .addChoices(
          { name: 'Panel',             value: 'panel' },
          { name: 'Dokumentationen',   value: 'dokumentationen' },
          { name: 'Urlaubsanträge',    value: 'urlaubsantraege' },
          { name: 'Backup',            value: 'backup' },
          { name: 'Monatliches Panel', value: 'monatliches_panel' },
        ))
      .addChannelOption(o => o.setName('kanal').setDescription('Der Kanal').setRequired(true)))
    .addSubcommand(s => s.setName('mindestshift').setDescription('Mindestshift-Stunden für eine Rolle festlegen')
      .addRoleOption(o => o.setName('rolle').setDescription('Die Rolle').setRequired(true))
      .addNumberOption(o => o.setName('stunden').setDescription('Stunden pro Monat (0 = deaktiviert)').setRequired(true).setMinValue(0))),

  new SlashCommandBuilder()
    .setName('monatspanel').setDescription('Monatliches Übersichtspanel')
    .addSubcommand(s => s.setName('senden').setDescription('Sendet das Monatspanel sofort')),

  new SlashCommandBuilder()
    .setName('backup').setDescription('Sendet sofort ein Datenbank-Backup (nur Admins)'),

  new SlashCommandBuilder()
    .setName('reload').setDescription('Spielt ein Backup (JSON) wieder ein (nur Admins)')
    .addAttachmentOption(o => o.setName('datei').setDescription('backup.json Datei').setRequired(true)),
].map(c => c.toJSON());

// ────────────────────────────────────────────────────────────────────
//  BOT CLIENT
// ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`[Bot] Eingeloggt als ${client.user.tag} (ID: ${client.user.id})`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
    console.log(`[Bot] ${COMMANDS.length} Slash-Commands registriert.`);
  } catch (e) {
    console.error('[Bot] Command-Registrierung fehlgeschlagen:', e);
  }

  setInterval(async () => {
    const db  = loadDB();
    const cid = db.config.kanaele.backup;
    if (!cid) return;
    for (const g of client.guilds.cache.values()) {
      const ch = g.channels.cache.get(cid);
      if (ch?.isTextBased()) { await backupSenden(ch).catch(console.error); break; }
    }
  }, 24 * 60 * 60 * 1000);

  setInterval(async () => {
    const db  = loadDB();

    const mpCid = db.config.kanaele.monatliches_panel;
    if (mpCid) {
      const now     = new Date();
      const letzter = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
      if (now.getUTCDate() >= letzter) {
        const letztTs = db.config.letztes_monatspanel;
        const already = letztTs
          ? new Date(letztTs * 1000).getUTCMonth() === now.getUTCMonth()
            && new Date(letztTs * 1000).getUTCFullYear() === now.getUTCFullYear()
          : false;
        if (!already) {
          for (const g of client.guilds.cache.values()) {
            const ch = g.channels.cache.get(mpCid);
            if (ch?.isTextBased()) { await monatlichesPanelSenden(g, ch).catch(console.error); break; }
          }
        }
      }
    }

    await checkUrlaubErinnerungen().catch(console.error);
    await checkShiftAnomalien().catch(console.error);

  }, 30 * 60 * 1000);
});

// ────────────────────────────────────────────────────────────────────
//  URLAUBS-ENDE-ERINNERUNGEN
// ────────────────────────────────────────────────────────────────────
async function checkUrlaubErinnerungen() {
  const db    = loadDB();
  const now   = nowTs();
  const grenz = URLAUB_ERINNERUNG_STUNDEN * 3600;
  let   dirty = false;

  for (const [uid, leaveData] of Object.entries(db.leave)) {
    for (const eintrag of (leaveData.aktiv ?? [])) {
      const endTs = eintrag.end_zeitstempel ?? 0;
      if (endTs <= now) continue;
      if (endTs - now > grenz) continue;
      if (db.notified.urlaub_ende[uid] === endTs) continue;

      for (const g of client.guilds.cache.values()) {
        const m = g.members.cache.get(uid) ?? await g.members.fetch(uid).catch(() => null);
        if (m) {
          await dmSend(m, dmContainerUrlaubEndeErinnerung(endTs));
          console.log(`[Erinnerung] Urlaubs-Ende-DM an ${uid} (endet ${tsDisc(endTs, 'F')})`);
          break;
        }
      }
      db.notified.urlaub_ende[uid] = endTs;
      dirty = true;
    }
  }
  if (dirty) saveDB(db);
}

// ────────────────────────────────────────────────────────────────────
//  SHIFT-ANOMALIE-WARNUNGEN
// ────────────────────────────────────────────────────────────────────
async function checkShiftAnomalien() {
  const db      = loadDB();
  const grenzSek = SHIFT_ANOMALIE_STUNDEN * 3600;
  let   dirty   = false;

  for (const [uid, shift] of Object.entries(db.shifts)) {
    if (shift?.status !== 'aktiv') continue;
    const laufSek = aktuelleShiftSekunden(shift);
    if (laufSek <= grenzSek) continue;
    if (db.notified.shift_anomalie[uid] === true) continue;

    const leitIds = db.config.rollen.leitungsebene ?? [];
    for (const g of client.guilds.cache.values()) {
      for (const leitId of leitIds) {
        const m = g.members.cache.get(leitId) ?? await g.members.fetch(leitId).catch(() => null);
        if (m && !m.user.bot) {
          await dmSend(m, dmContainerShiftAnomalie(uid, laufSek));
          console.log(`[Anomalie] Shift-Warnung für ${uid} (${formatDuration(laufSek)}) -> ${leitId}`);
        }
      }
    }
    db.notified.shift_anomalie[uid] = true;
    dirty = true;
  }

  for (const uid of Object.keys(db.notified.shift_anomalie)) {
    if (!db.shifts[uid]) {
      delete db.notified.shift_anomalie[uid];
      dirty = true;
    }
  }
  if (dirty) saveDB(db);
}

// ────────────────────────────────────────────────────────────────────
//  INTERACTION ROUTER
// ────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isButton())           return await handleButton(interaction);
    if (interaction.isModalSubmit())      return await handleModal(interaction);
  } catch (e) {
    console.error('[Interaction] Fehler:', e);
    const msg = { content: `Interner Fehler: \`${e.message}\``, ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {}
  }
});

// ────────────────────────────────────────────────────────────────────
//  SLASH-COMMAND HANDLER
// ────────────────────────────────────────────────────────────────────
async function handleCommand(i) {
  const cmd = i.commandName;
  const sub = i.options.getSubcommand(false);

  function infoContainer(accentColor, title, description, extraFields = []) {
    const c = new ContainerBuilder()
      .addTextDisplayComponents(makeText(`## ${title}`));
    if (description) {
      c.addSeparatorComponents(makeSeparator());
      c.addTextDisplayComponents(makeText(description));
    }
    for (const f of extraFields) {
      c.addSeparatorComponents(makeSeparator());
      c.addTextDisplayComponents(makeText(f));
    }
    c.addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
    return c;
  }

  // ═══ /stats ══════════════════════════════════════════════════════
  if (cmd === 'stats') {
    if (!isMitarbeiter(i.member)) return i.reply({ content: 'Fehler: `Mitarbeiter` benötigt!', ephemeral: true });

    const zielMember = i.options.getMember('user');
    const ziel       = zielMember ?? i.member;

    if (zielMember && String(ziel.id) !== String(i.user.id) && !isLeitungsebene(i.member))
      return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });

    const db  = loadDB();
    const uid = String(ziel.id);
    ensureUser(db, uid);
    const nd  = db.users[uid];
    const aktiv = db.shifts[uid];

    const gesamtSek = (nd.gesamt_shift_sekunden ?? 0) + (aktiv ? aktuelleShiftSekunden(aktiv) : 0);
    const avg       = durchschnitt(nd);
    const laengste  = nd.laengste_shift_sekunden ?? 0;
    const urlaubstage = nd.urlaubstage ?? 0;
    const tickets   = nd.tickets ?? 0;
    const shiftAnz  = nd.shift_anzahl ?? 0;

    let aktivLine = '`—`';
    if (aktiv) {
      const laufSek = aktuelleShiftSekunden(aktiv);
      const statLabel = { aktiv: 'Aktiv', pausiert: 'Pausiert', inaktiv: 'Inaktiv', beendet: 'Beendet' };
      aktivLine = `\`${formatDuration(laufSek)}\` (${statLabel[aktiv.status] ?? aktiv.status})`;
    }

    const urlaubStatus = hatAktivenOderAusstehendUrlaub(db, uid);
    let urlaubLine = '`Kein aktiver Urlaub`';
    if (urlaubStatus === 'aktiv') {
      const aktUrlaub = (db.leave[uid]?.aktiv ?? []).find(a => (a.end_zeitstempel ?? 0) > nowTs());
      if (aktUrlaub) urlaubLine = `Aktiv — endet ${tsDisc(aktUrlaub.end_zeitstempel, 'R')}`;
    } else if (urlaubStatus === 'ausstehend') {
      urlaubLine = `Antrag ausstehend`;
    }

    const container = new ContainerBuilder()
      .addTextDisplayComponents(makeText(`## Statistik — <@${uid}>`))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(
        `**Schichten**\n`
        + `> **Gesamt-Schichten:** \`${shiftAnz}\`\n`
        + `> **Gesamtdauer:** \`${formatDuration(gesamtSek)}\`\n`
        + `> **Durchschnitt:** \`${formatDuration(avg)}\`\n`
        + (laengste > 0 ? `> **Längste Schicht:** \`${formatDuration(laengste)}\`\n` : '')
        + `> **Aktuell:** ${aktivLine}`
      ))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(
        `**Tickets & Urlaub**\n`
        + `> **Tickets gesamt:** \`${tickets}\`\n`
        + `> **Urlaubstage gesamt:** \`${urlaubstage}\`\n`
        + `> **Urlaub:** ${urlaubLine}`
      ))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

    return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
  }

  // ═══ /urlaubskalender ═══════════════════════════════════════════
  if (cmd === 'urlaubskalender') {
    if (!isMitarbeiter(i.member)) return i.reply({ content: 'Fehler: `Mitarbeiter` benötigt!', ephemeral: true });

    const db  = loadDB();
    const now = nowTs();

    const liste = [];
    for (const [uid, d] of Object.entries(db.leave)) {
      for (const a of (d.aktiv ?? [])) {
        if ((a.end_zeitstempel ?? 0) > now) {
          liste.push({ uid, end: a.end_zeitstempel, start: a.start_zeitstempel ?? now });
        }
      }
      for (const e of (d.eintraege ?? [])) {
        if (e.status === 'ausstehend') {
          liste.push({ uid, end: e.end_zeitstempel ?? 0, start: e.zeitstempel, ausstehend: true });
        }
      }
    }
    liste.sort((a, b) => a.end - b.end);

    let zeilen = '';
    if (liste.length === 0) {
      zeilen = 'Aktuell sind keine Urlaube aktiv oder ausstehend.';
    } else {
      zeilen = liste.map((a, n) => {
        const status  = a.ausstehend ? ' *(ausstehend)*' : '';
        const restsek = Math.max(0, a.end - now);
        const balken  = restsek < 86400 ? '[' : restsek < 3 * 86400 ? '[--' : '[----';
        return `<@${a.uid}>${status}\n> ${tsDisc(a.start, 'D')} bis ${tsDisc(a.end, 'D')} — noch ${formatRelative(restsek)} ${balken}]`;
      }).join('\n\n');
    }

    const container = new ContainerBuilder()
      .addTextDisplayComponents(makeText('## Urlaubskalender'))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(zeilen))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

    return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
  }

  // ═══ /shift ═════════════════════════════════════════════════════
  if (cmd === 'shift') {
    if (!isMitarbeiter(i.member)) return i.reply({ content: 'Fehler: `Mitarbeiter` benötigt!', ephemeral: true });

    if (sub === 'manage') {
      const db   = loadDB();
      const uid  = String(i.user.id);
      const s    = db.shifts[uid];
      const stat = s?.status ?? 'inaktiv';
      return i.reply({ ...buildShiftContainer(i.member, stat, db) });
    }

    if (sub === 'active') {
      const db    = loadDB();
      const aktiv = Object.entries(db.shifts).filter(([, s]) => ['aktiv', 'pausiert'].includes(s?.status));
      const zeilen = aktiv.length
        ? aktiv.map(([uid, s]) => {
            const laufSek  = aktuelleShiftSekunden(s);
            const statText = s.status === 'aktiv' ? 'Aktiv' : 'Pausiert';
            const anomalie = laufSek > SHIFT_ANOMALIE_STUNDEN * 3600 ? ' — Achtung: lange aktiv' : '';
            return `**${statText}** <@${uid}> — ${formatDuration(laufSek)}${anomalie}`;
          }).join('\n')
        : 'Derzeit keine aktiven Schichten.';

      const container = new ContainerBuilder()
        .addTextDisplayComponents(makeText('## Aktive Schichten'))
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(zeilen))
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
      return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }

    if (sub === 'leaderboard') {
      await i.deferReply({ ephemeral: true });
      await i.guild.members.fetch().catch(() => {});
      const db      = loadDB();
      const alleIds = new Set([...db.config.rollen.leitungsebene, ...db.config.rollen.mitarbeiter]);
      const entries = [];
      for (const m of i.guild.members.cache.values()) {
        if (m.user.bot) continue;
        if (!m.roles.cache.some(r => alleIds.has(String(r.id)))) continue;
        entries.push([String(m.id), db.users[String(m.id)]?.gesamt_shift_sekunden ?? 0]);
      }
      entries.sort((a, b) => b[1] - a[1]);
      const zeilen = entries.slice(0, 10).map(([uid, s], idx) =>
        `\`${idx + 1}.\` <@${uid}> — ${formatDuration(s)}`
      ).join('\n') || 'Keine Daten vorhanden.';

      const container = new ContainerBuilder()
        .addTextDisplayComponents(makeText('## Shift Leaderboard'))
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(zeilen))
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
      return i.followUp({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }

    if (sub === 'admin') {
      if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
      const ziel = i.options.getMember('user');
      const db   = loadDB();
      return i.reply({ ...buildShiftAdminContainer(ziel, db), ephemeral: true });
    }
  }

  // ═══ /leave ══════════════════════════════════════════════════════
  if (cmd === 'leave') {
    if (!isMitarbeiter(i.member)) return i.reply({ content: 'Fehler: `Mitarbeiter` benötigt!', ephemeral: true });

    if (sub === 'manage') {
      const db     = loadDB();
      const uid    = String(i.user.id);
      const eintr  = db.leave[uid]?.eintraege ?? [];
      const zeilen = eintr.slice(-3).map((e, n) =>
        `${n + 1}. ${datumDe(e.zeitstempel)} — ${formatDauer(e.dauer ?? '?')} — \`${e.status}\``
      );

      const blockierungsgrund = hatAktivenOderAusstehendUrlaub(db, uid);
      const antragDisabled    = !!blockierungsgrund;
      const antragLabel       = blockierungsgrund === 'aktiv'
        ? 'Urlaub läuft bereits'
        : blockierungsgrund === 'ausstehend'
        ? 'Antrag ausstehend'
        : 'Antrag stellen';

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('uv_start').setLabel(antragLabel).setStyle(ButtonStyle.Success).setDisabled(antragDisabled),
        new ButtonBuilder().setCustomId('uv_history').setLabel('Erweiterte Historie').setStyle(ButtonStyle.Secondary),
      );

      const container = new ContainerBuilder()
        .addTextDisplayComponents(makeText(`## Urlaubsverwaltung\n> <@${i.user.id}>`))
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(
          `**Letzte Einträge**\n`
          + (zeilen.join('\n') || 'Keine Urlaubseinträge.')
        ))
        .addSeparatorComponents(makeSeparator())
        .addActionRowComponents(row)
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

      return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }

    if (sub === 'active') {
      const db  = loadDB();
      const now = nowTs();
      const list = [];
      for (const [uid, d] of Object.entries(db.leave)) {
        for (const a of (d.aktiv ?? [])) {
          if ((a.end_zeitstempel ?? 0) > now) {
            list.push({ uid, end: a.end_zeitstempel });
          }
        }
      }
      list.sort((a, b) => a.end - b.end);
      const zeilen = list.length
        ? list.map((a, n) =>
            `${n + 1}. <@${a.uid}> — Endet ${tsDisc(a.end, 'F')} (${tsDisc(a.end, 'R')})`
          ).join('\n')
        : 'Aktuell befinden sich keine Mitarbeiter im Urlaub.';

      const container = new ContainerBuilder()
        .addTextDisplayComponents(makeText('## Aktive Urlaubsabwesenheiten'))
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(zeilen))
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
      return i.reply({ components: [container], flags: CV2_FLAG });
    }

    if (sub === 'admin') {
      if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
      const ziel  = i.options.getMember('user');
      const uid   = String(ziel.id);
      const db    = loadDB();
      const eintr = db.leave[uid]?.eintraege ?? [];
      const now   = nowTs();
      const aktiv = (db.leave[uid]?.aktiv ?? []).filter(a => (a.end_zeitstempel ?? 0) > now);

      let aktivLine = '';
      if (aktiv.length) {
        aktivLine = `> Endet ${tsDisc(aktiv[0].end_zeitstempel, 'F')} (noch ${formatRelative(aktiv[0].end_zeitstempel - now)})`;
      }
      const zeilen = eintr.slice(-3).map((e, n) =>
        `${n + 1}. ${datumDe(e.zeitstempel)} — ${formatDauer(e.dauer ?? '?')} — \`${e.status}\``
      );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`la_start_${uid}`).setLabel('Urlaub starten').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`la_end_${uid}`).setLabel('Urlaub beenden').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`la_ext_${uid}`).setLabel('Verlängern').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`la_hist_${uid}`).setLabel('Alle Einträge').setStyle(ButtonStyle.Secondary),
      );

      const container = new ContainerBuilder()
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(makeText(`## Urlaubsverwaltung — <@${uid}>`))
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`leave_admin_status_noop_${uid}_${Date.now()}`)
                .setLabel(aktiv.length ? 'Aktiv' : 'Inaktiv')
                .setStyle(aktiv.length ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(true)
            )
        );

      if (aktivLine) {
        container.addSeparatorComponents(makeSeparator());
        container.addTextDisplayComponents(makeText(aktivLine));
      }

      container
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(
          `**Letzte Einträge:**\n`
          + (zeilen.join('\n') || 'Keine Einträge.')
        ))
        .addSeparatorComponents(makeSeparator())
        .addActionRowComponents(row)
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

      return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }
  }

  // ═══ /ticket ═════════════════════════════════════════════════════
  if (cmd === 'ticket') {
    if (sub === 'leaderboard') {
      if (!isMitarbeiter(i.member)) return i.reply({ content: 'Fehler: `Mitarbeiter` benötigt!', ephemeral: true });
      const db     = loadDB();
      const sorted = Object.entries(db.users)
        .filter(([, d]) => (d.tickets ?? 0) > 0)
        .sort((a, b) => b[1].tickets - a[1].tickets)
        .slice(0, 10);
      const zeilen = sorted.map(([uid, d], n) =>
        `\`${n + 1}.\` <@${uid}> — \`${d.tickets}\` Tickets`
      ).join('\n') || 'Noch keine Ticket-Daten vorhanden.';

      const container = new ContainerBuilder()
        .addTextDisplayComponents(makeText('## Ticket Leaderboard'))
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(zeilen))
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
      return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }

    if (sub === 'admin') {
      if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
      const user   = i.options.getMember('user');
      const aktion = i.options.getString('aktion');
      const anzahl = i.options.getInteger('anzahl');
      const db     = loadDB();
      const uid    = String(user.id);
      ensureUser(db, uid);
      const vorher = db.users[uid].tickets ?? 0;
      db.users[uid].tickets      = aktion === 'add' ? vorher + anzahl : Math.max(0, vorher - anzahl);
      db.users[uid].benutzername = user.displayName;
      const nachher  = db.users[uid].tickets;
      saveDB(db);
      const aktText  = aktion === 'add' ? `+${anzahl} hinzugefügt` : `-${Math.min(anzahl, vorher)} entfernt`;
      const titel    = aktion === 'add' ? 'Tickets hinzugefügt' : 'Tickets entfernt';
      const container = infoContainer(COLOR, titel, null, [
        `> **Mitarbeiter:** <@${uid}>`,
        `> **Aktion:** \`${aktText}\``,
        `> **Tickets:** \`${nachher}\``,
      ]);
      return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }
  }

  // ═══ /gehalt ═════════════════════════════════════════════════════
  if (cmd === 'gehalt') {
    if (sub === 'anzeigen') {
      if (!isMitarbeiter(i.member)) return i.reply({ content: 'Fehler: `Mitarbeiter` benötigt!', ephemeral: true });
      const zielMember = i.options.getMember('user');
      const ziel       = zielMember ?? i.member;
      if (zielMember && String(ziel.id) !== String(i.user.id) && !isLeitungsebene(i.member))
        return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
      const db  = loadDB();
      const uid = String(ziel.id);
      if (!db.users[uid]) return i.reply({ content: `Noch keine Daten für <@${uid}> gefunden!`, ephemeral: true });
      return i.reply({ ...buildGehaltContainer(i.guild, ziel, gehaltBerechnen(ziel, db.users[uid], db)), ephemeral: true });
    }

    if (sub === 'konfigurieren') {
      if (!isAdmin(i.user.id)) return i.reply({ content: 'Fehler: `Administrator` benötigt!', ephemeral: true });
      const kat   = i.options.getString('kategorie');
      const rolle = i.options.getRole('rolle');
      const bet   = i.options.getNumber('betrag');
      const db    = loadDB();
      const rid   = String(rolle.id);
      if (!db.salary.rollen[rid]) db.salary.rollen[rid] = { shift_pro_stunde: 0, ticket_bonus: 0, mindest_shift_stunden: 0 };
      db.salary.rollen[rid][kat === 'shift' ? 'shift_pro_stunde' : 'ticket_bonus'] = bet;
      saveDB(db);
      const container = infoContainer(COLOR, 'Gehalt konfiguriert', null, [
        `> **Rolle:** ${rolle}\n> **Kategorie:** ${kat === 'shift' ? 'Schicht (pro Stunde)' : 'Ticket (pro Ticket)'}\n> **Betrag:** **${bet.toFixed(2)} €**`,
      ]);
      return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }

    if (sub === 'export') {
      if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
      await i.deferReply({ ephemeral: true });

      await i.guild.members.fetch().catch(() => {});

      const db    = loadDB();
      const jetzt = new Date();
      const datumStr = jetzt.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });

      const mpCid   = db.config.kanaele.monatliches_panel;
      const mpKanal = mpCid ? i.guild.channels.cache.get(mpCid) : null;
      if (!mpKanal?.isTextBased())
        return i.followUp({ content: 'Fehler: `Monatliches-Panel-Kanal` nicht konfiguriert oder nicht gefunden!', ephemeral: true });

      const zeilen = Object.entries(db.users).map(([uid, nd]) => {
        const member  = i.guild.members.cache.get(uid);
        const stunden = Math.floor((nd.gesamt_shift_sekunden ?? 0) / 3600);
        const minuten = Math.floor(((nd.gesamt_shift_sekunden ?? 0) % 3600) / 60);
        const name    = member?.displayName || nd.benutzername || uid;

        let roleName = '—';
        if (member) {
          const gehaltsRollen = new Set(Object.keys(db.salary.rollen ?? {}));
          const sortedRoles = [...member.roles.cache.values()]
            .filter(r => gehaltsRollen.has(String(r.id)))
            .sort((a, b) => b.position - a.position);
          if (sortedRoles.length) roleName = sortedRoles[0].name;
        }

        const gehaltData = member ? gehaltBerechnen(member, nd, db) : { gesamt_gehalt: 0 };

        return {
          uid, name, stunden, minuten,
          tickets:  nd.tickets     ?? 0,
          urlTage:  nd.urlaubstage ?? 0,
          anzahl:   nd.shift_anzahl ?? 0,
          sekunden: nd.gesamt_shift_sekunden ?? 0,
          roleName,
          gehalt: gehaltData.gesamt_gehalt,
        };
      }).sort((a, b) => b.sekunden - a.sekunden);

      const sumSek     = zeilen.reduce((s, r) => s + r.sekunden, 0);
      const sumStunden = Math.floor(sumSek / 3600);
      const sumMin     = Math.floor((sumSek % 3600) / 60);
      const sumTickets = zeilen.reduce((s, r) => s + r.tickets, 0);
      const sumGehalt  = zeilen.reduce((s, r) => s + r.gehalt,  0);

      const tabellenzeilen = zeilen.map((r, idx) =>
        `<tr class="${idx % 2 === 0 ? 'even' : 'odd'}">
          <td class="rank">${idx + 1}</td>
          <td class="name">${escapeHtml(r.name)}</td>
          <td class="role">${escapeHtml(r.roleName)}</td>
          <td class="center">${r.anzahl}</td>
          <td class="center">${r.stunden}h ${String(r.minuten).padStart(2, '0')}m</td>
          <td class="center">${r.tickets}</td>
          <td class="center">${r.urlTage}</td>
          <td class="salary">${r.gehalt.toFixed(2)} €</td>
        </tr>`
      ).join('');

      const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gehaltsabrechnung — Hamburger Heimat Bank</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:        #0d0b0b;
      --surface:   #181212;
      --border:    #2e1a18;
      --accent:    #C8341C;
      --accent2:   #8c2414;
      --text:      #f0ebe8;
      --muted:     #7a6560;
      --even:      #1c1411;
      --odd:       #181212;
      --salary-fg: #f5c2b0;
    }
    body { font-family: 'IBM Plex Sans', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 48px 32px; }
    .page { max-width: 960px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 40px; }
    .header-left .bank-name { font-size: 11px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); margin-bottom: 6px; }
    .header-left h1 { font-size: 28px; font-weight: 700; color: var(--text); letter-spacing: -0.02em; }
    .header-right { text-align: right; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--muted); line-height: 1.8; }
    .header-right .val { color: var(--text); font-weight: 600; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 40px; }
    .kpi-card { background: var(--surface); border: 1px solid var(--border); border-top: 2px solid var(--accent); padding: 20px 24px; }
    .kpi-label { font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
    .kpi-value { font-family: 'IBM Plex Mono', monospace; font-size: 24px; font-weight: 600; color: var(--accent); }
    .kpi-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .table-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .table-title { font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    thead tr { border-bottom: 1px solid var(--accent2); }
    thead th { font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); padding: 10px 16px; text-align: left; }
    thead th.center { text-align: center; }
    thead th.right  { text-align: right;  }
    tbody tr.even { background: var(--even); }
    tbody tr.odd  { background: var(--odd); }
    tbody tr:hover { background: #221618; }
    tbody td { padding: 13px 16px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
    td.rank   { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--muted); width: 40px; }
    td.name   { font-weight: 600; }
    td.role   { font-size: 12px; color: var(--muted); }
    td.center { text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
    td.salary { text-align: right; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 600; color: var(--salary-fg); }
    .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="header-left">
        <div class="bank-name">Hamburger Heimat Bank</div>
        <h1>Gehaltsabrechnung</h1>
      </div>
      <div class="header-right">
        <div>Erstellt am <span class="val">${datumStr}</span></div>
        <div>Angefragt von <span class="val">${escapeHtml(i.member.displayName)}</span></div>
        <div>Mitarbeiter erfasst: <span class="val">${zeilen.length}</span></div>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Gesamt-Schichtzeit</div>
        <div class="kpi-value">${sumStunden}h ${String(sumMin).padStart(2, '0')}m</div>
        <div class="kpi-sub">Team-Gesamtleistung</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Gesamt-Tickets</div>
        <div class="kpi-value">${sumTickets}</div>
        <div class="kpi-sub">Bearbeitete Tickets</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Erfasste Mitarbeiter</div>
        <div class="kpi-value">${zeilen.length}</div>
        <div class="kpi-sub">Mit Aktivitätsdaten</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Gesamtgehalt</div>
        <div class="kpi-value">${sumGehalt.toFixed(2)} €</div>
        <div class="kpi-sub">Alle Mitarbeiter</div>
      </div>
    </div>
    <div class="table-header"><div class="table-title">Mitarbeiter-Übersicht</div></div>
    <table>
      <thead>
        <tr>
          <th>#</th><th>Name</th><th>Rolle</th>
          <th class="center">Schichten</th><th class="center">Schichtzeit</th>
          <th class="center">Tickets</th><th class="center">Urlaubstage</th>
          <th class="right">Gehalt</th>
        </tr>
      </thead>
      <tbody>${tabellenzeilen}</tbody>
    </table>
    <div class="footer">
      <span>Copyright &copy; Hamburger Heimat Bank</span>
      <span>Gehaltsabrechnung &mdash; ${datumStr}</span>
    </div>
  </div>
</body>
</html>`;

      const fileName = `gehaltsabrechnung_${jetzt.toISOString().slice(0, 10)}.html`;
      const att = new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName });

      const headerContainer = new ContainerBuilder()
        .addTextDisplayComponents(makeText(
          `## Gehaltsabrechnung — ${datumStr}\n`
          + `> Angefragt von ${i.user} — \`${zeilen.length}\` Mitarbeiter — Gesamtgehalt: **${sumGehalt.toFixed(2)} €**`
        ))
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
      await mpKanal.send({ components: [headerContainer], flags: CV2_FLAG });
      await mpKanal.send({ files: [att] });

      const container = infoContainer(COLOR, 'Gehalt-Export', null, [
        `> **Angefragt von:** ${i.user}`,
        `> **Datum:** ${tsDisc(nowTs(), 'F')}\n> **Datei:** \`${fileName}\`\n> **Mitarbeiter:** \`${zeilen.length}\`\n> **Gesamtgehalt:** \`${sumGehalt.toFixed(2)} €\`\n> **Kanal:** <#${mpCid}>`,
      ]);
      return i.followUp({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }

    if (sub === 'reset') {
      if (!isAdmin(i.user.id)) return i.reply({ content: 'Fehler: `Administrator` benötigt!', ephemeral: true });
      const container = new ContainerBuilder()
        .addTextDisplayComponents(makeText('## Gehalt zurücksetzen'))
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(
          '> Diese Aktion löscht __alle__ Shift- und Ticketdaten dauerhaft.\n'
          + '> **Ein automatisches Backup wird vor dem Reset erstellt.**\n'
          + '> **Dieser Vorgang kann nicht rückgängig gemacht werden!**'
        ))
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('reset_confirm').setLabel('Zurücksetzen').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('reset_cancel').setLabel('Abbrechen').setStyle(ButtonStyle.Secondary),
      );
      return i.reply({ components: [container, row], flags: CV2_FLAG, ephemeral: true });
    }
  }

  // ═══ /konfiguriere ═══════════════════════════════════════════════
  if (cmd === 'konfiguriere') {
    if (!isAdmin(i.user.id)) return i.reply({ content: 'Fehler: `Administrator` benötigt!', ephemeral: true });
    await i.deferReply({ ephemeral: true });

    if (sub === 'rolle') {
      const stufe = i.options.getString('stufe');
      const rolle = i.options.getRole('rolle');
      const db    = loadDB();
      if (!db.config.rollen[stufe].includes(String(rolle.id))) {
        db.config.rollen[stufe].push(String(rolle.id));
        saveDB(db);
      }
      const container = infoContainer(COLOR, 'Konfiguration gespeichert', null, [
        `> **Rolle:** ${rolle}\n> **Berechtigung:** \`${stufe}\``,
      ]);
      return i.followUp({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }

    if (sub === 'kanal') {
      const funktion = i.options.getString('funktion');
      const kanal    = i.options.getChannel('kanal');
      const db       = loadDB();
      db.config.kanaele[funktion] = String(kanal.id);
      saveDB(db);

      const hinweise = [];
      if (funktion === 'backup')
        hinweise.push(`> Erstes automatisches Backup in **24 Stunden**. Manuell: \`/backup\``);
      if (funktion === 'monatliches_panel')
        hinweise.push(`> Panel wird automatisch am **letzten Tag** des Monats gesendet.\n> Manuell: \`/monatspanel senden\``);

      const container = infoContainer(COLOR, 'Konfiguration gespeichert',
        `> **Kanal:** ${kanal}\n> **Funktion:** \`${funktion}\``,
        hinweise
      );

      if (funktion === 'panel') await panelEmbedSenden(kanal);

      return i.followUp({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }

    if (sub === 'mindestshift') {
      const rolle   = i.options.getRole('rolle');
      const stunden = i.options.getNumber('stunden');
      const db      = loadDB();
      const rid     = String(rolle.id);
      if (!db.salary.rollen[rid]) db.salary.rollen[rid] = { shift_pro_stunde: 0, ticket_bonus: 0, mindest_shift_stunden: 0 };
      db.salary.rollen[rid].mindest_shift_stunden = stunden;
      saveDB(db);
      const desc = stunden <= 0
        ? `> Mindestshift für ${rolle} wurde **deaktiviert**.`
        : `> Mitarbeiter mit Rolle ${rolle} benötigen mindestens **${stunden.toFixed(1)} Stunden** pro Monat.`;
      const container = infoContainer(COLOR, 'Mindestshift konfiguriert', desc, [
        `> **Rolle:** ${rolle}\n> **Mindestshift:** \`${stunden.toFixed(1)}\` Stunden/Monat`,
      ]);
      return i.followUp({ components: [container], flags: CV2_FLAG, ephemeral: true });
    }
  }

  // ═══ /monatspanel ════════════════════════════════════════════════
  if (cmd === 'monatspanel' && sub === 'senden') {
    if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
    const db  = loadDB();
    const cid = db.config.kanaele.monatliches_panel;
    if (!cid) return i.reply({ content: 'Fehler: `Monatliches-Panel-Kanal` nicht konfiguriert!', ephemeral: true });
    const ch = i.guild.channels.cache.get(cid);
    if (!ch)  return i.reply({ content: 'Fehler: Kanal nicht gefunden!', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    await monatlichesPanelSenden(i.guild, ch);
    const container = infoContainer(COLOR, 'Monatspanel gesendet', `Das Monatspanel wurde in ${ch} gesendet.`);
    return i.followUp({ components: [container], flags: CV2_FLAG, ephemeral: true });
  }

  // ═══ /backup ═════════════════════════════════════════════════════
  if (cmd === 'backup') {
    if (!isAdmin(i.user.id)) return i.reply({ content: 'Fehler: `Administrator` benötigt!', ephemeral: true });
    const db  = loadDB();
    const cid = db.config.kanaele.backup;
    if (!cid) return i.reply({ content: 'Fehler: `Backup-Kanal` nicht konfiguriert!', ephemeral: true });
    const ch = i.guild.channels.cache.get(cid);
    if (!ch)  return i.reply({ content: 'Fehler: `Backup-Kanal` nicht gefunden!', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    await backupSenden(ch);
    const container = infoContainer(COLOR, 'Backup gesendet', `Die Datenbank wurde als JSON in ${ch} gesichert.`);
    return i.followUp({ components: [container], flags: CV2_FLAG, ephemeral: true });
  }

  // ═══ /reload ═════════════════════════════════════════════════════
  if (cmd === 'reload') {
    if (!isAdmin(i.user.id)) return i.reply({ content: 'Fehler: `Administrator` benötigt!', ephemeral: true });
    const att = i.options.getAttachment('datei');
    if (!att.name.endsWith('.json')) return i.reply({ content: 'Fehler: Bitte nur `.json`-Dateien hochladen!', ephemeral: true });
    await i.deferReply({ ephemeral: true });

    try {
      const res  = await fetch(att.url);
      const text = await res.text();
      const data = JSON.parse(text);

      const keys    = ['config', 'shifts', 'users', 'salary', 'leave'];
      const missing = keys.filter(k => !(k in data));
      if (missing.length) throw new Error(`Fehlende Schlüssel: ${missing.join(', ')}`);

      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');

      const container = infoContainer(COLOR, 'Backup eingespielt', null, [
        `> **Datei:** \`${att.name}\``,
        `> **Zeitpunkt:** ${tsDisc(nowTs(), 'F')}`,
      ]);
      return i.followUp({ components: [container], flags: CV2_FLAG, ephemeral: true });
    } catch (e) {
      return i.followUp({ content: `Fehler beim Einspielen: \`${e.message}\``, ephemeral: true });
    }
  }
}

// ────────────────────────────────────────────────────────────────────
//  BUTTON HANDLER
// ────────────────────────────────────────────────────────────────────
async function handleButton(i) {
  const id  = i.customId;
  const now = Date.now() / 1000;

  if (id.startsWith('sv_start_') || id.startsWith('sv_pause_') || id.startsWith('sv_end_')) {
    const parts  = id.split('_');
    const action = parts[1];
    const uid    = parts.slice(2).join('_');

    if (String(i.user.id) !== uid) {
      return i.reply({ content: 'Diese Buttons gehören nicht dir.', ephemeral: true });
    }

    const db = loadDB();

    if (action === 'start') {
      let s = db.shifts[uid] ?? {};
      if (s.status === 'pausiert') {
        s.gesamt_pause_sekunden = (s.gesamt_pause_sekunden ?? 0) + (now - (s.pause_start ?? now));
        s.pause_start = null;
        s.status      = 'aktiv';
      } else {
        s = { status: 'aktiv', start_zeit: now, pause_start: null, gesamt_pause_sekunden: 0, gespeicherte_sekunden: 0, benutzername: i.member.displayName };
      }
      db.shifts[uid] = s;
      db.notified.shift_anomalie[uid] = false;
      ensureUser(db, uid);
      db.users[uid].benutzername = i.member.displayName;
      saveDB(db);
      return i.update({ ...buildShiftContainer(i.member, 'aktiv', db) });
    }

    if (action === 'pause') {
      const s = db.shifts[uid];
      if (!s || s.status !== 'aktiv') return i.reply({ content: 'Fehler: Shift nicht aktiv!', ephemeral: true });
      s.status = 'pausiert'; s.pause_start = now;
      saveDB(db);
      return i.update({ ...buildShiftContainer(i.member, 'pausiert', db) });
    }

    if (action === 'end') {
      const s = db.shifts[uid];
      if (!s) return i.reply({ content: 'Fehler: Kein aktiver Shift!', ephemeral: true });
      let pause = s.gesamt_pause_sekunden ?? 0;
      if (s.status === 'pausiert') pause += now - (s.pause_start ?? now);
      const gesamt = Math.max(0, (s.gespeicherte_sekunden ?? 0) + (now - (s.start_zeit ?? now)) - pause);
      ensureUser(db, uid);
      db.users[uid].gesamt_shift_sekunden += gesamt;
      db.users[uid].shift_anzahl          += 1;
      db.users[uid].laengste_shift_sekunden = Math.max(
        db.users[uid].laengste_shift_sekunden ?? 0, gesamt
      );
      db.users[uid].benutzername           = i.member.displayName;
      delete db.notified.shift_anomalie[uid];
      delete db.shifts[uid];
      saveDB(db);
      return i.update({
        ...buildShiftContainer(
          i.member, 'beendet', db,
          `**Shift beendet** — Dauer: **${formatDuration(gesamt)}**`
        ),
      });
    }
  }

  if (id === 'ticket_erstellen') {
    return i.showModal(
      new ModalBuilder().setCustomId('m_ticket').setTitle('Neue Dokumentation')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_name').setLabel('Name des Tickets').setPlaceholder('[Kategorie]-[User]').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('worum').setLabel('Worum ging es?').setStyle(TextInputStyle.Paragraph).setPlaceholder('Beschreibe worum es im Ticket ging.').setRequired(true).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('probleme').setLabel('Gab es Probleme?').setStyle(TextInputStyle.Paragraph).setPlaceholder("Falls ja, beschreibe sie. Falls nein: 'Keine'.").setRequired(true).setMaxLength(1000)),
        ),
    );
  }

  if (id === 'uv_start') {
    const db             = loadDB();
    const uid            = String(i.user.id);
    const blockierung    = hatAktivenOderAusstehendUrlaub(db, uid);
    if (blockierung === 'aktiv') {
      return i.reply({ content: '> Du hast bereits einen **aktiven Urlaub**. Wende dich an die Leitungsebene, falls du einen weiteren benötigst.', ephemeral: true });
    }
    if (blockierung === 'ausstehend') {
      return i.reply({ content: '> Du hast bereits einen **ausstehenden Antrag**. Warte bis dieser bearbeitet wurde.', ephemeral: true });
    }

    return i.showModal(
      new ModalBuilder().setCustomId('m_urlaub_antrag').setTitle('Urlaubsantrag stellen')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('begruendung').setLabel('Begründung').setStyle(TextInputStyle.Paragraph).setPlaceholder('Warum möchtest du Urlaub nehmen?').setRequired(true).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dauer').setLabel('Dauer').setPlaceholder('1d = 1 Tag  |  2w = 2 Wochen  |  1m = 1 Monat').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
        ),
    );
  }

  if (id === 'uv_history') {
    const db    = loadDB();
    const uid   = String(i.user.id);
    const eintr = db.leave[uid]?.eintraege ?? [];
    const zeilen = eintr.map((e, n) =>
      `${n + 1}. ${datumDe(e.zeitstempel)} — ${formatDauer(e.dauer ?? '?')} — \`${e.status}\``
    );
    const container = new ContainerBuilder()
      .addTextDisplayComponents(makeText(`## Urlaubsverwaltung — Alle Einträge\n> <@${uid}>`))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(zeilen.join('\n') || 'Keine Urlaubseinträge.'))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
    return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
  }

  if (id.startsWith('gen_approve_') || id.startsWith('gen_reject_')) {
    if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
    const parts  = id.split('_');
    const action = parts[1];
    const uid    = parts[2];
    const dauer  = parts[3];
    const durSek = parseInt(parts[4] ?? '86400');
    const ts     = nowTs();
    const endTs  = ts + durSek;

    if (action === 'approve') {
      const db = loadDB();
      if (!db.leave[uid]) db.leave[uid] = { eintraege: [], aktiv: [] };

      for (const e of db.leave[uid].eintraege) {
        if (e.status === 'ausstehend') e.status = 'genehmigt';
      }
      db.leave[uid].eintraege.push({ dauer, zeitstempel: ts, start_zeitstempel: ts, end_zeitstempel: endTs, status: 'genehmigt' });
      db.leave[uid].aktiv.push({ dauer, start_zeitstempel: ts, end_zeitstempel: endTs, benutzername: '' });
      ensureUser(db, uid);
      db.users[uid].urlaubstage = (db.users[uid].urlaubstage ?? 0) + dauerZuTage(dauer);
      delete db.notified.urlaub_ende[uid];
      saveDB(db);
      const m = i.guild?.members.cache.get(uid);
      if (m) await dmGenehmigt(i.guild, m, dauer, endTs);

      const allTexts = i.message.components[0]?.components
        ?.filter(c => c.type === ComponentType.TextDisplay)
        ?.map(c => c.content) ?? [];
      const keepTexts = allTexts.slice(0, -1);

      const updatedContainer = new ContainerBuilder()
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(makeText('## Genehmigter Urlaubsantrag'))
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`leave_status_noop_genehmigt_${Date.now()}`)
                .setLabel('Genehmigt')
                .setStyle(ButtonStyle.Success)
                .setDisabled(true)
            )
        );

      for (const text of keepTexts) {
        updatedContainer
          .addSeparatorComponents(makeSeparator())
          .addTextDisplayComponents(makeText(text));
      }

      updatedContainer
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(`> **Bearbeitet von:** ${i.user}`))
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

      await i.message.edit({ components: [updatedContainer], flags: CV2_FLAG });
      return i.reply({ content: 'Antrag genehmigt!', ephemeral: true });
    }

    if (action === 'reject') {
      const db = loadDB();
      if (db.leave[uid]) {
        for (const e of db.leave[uid].eintraege) {
          if (e.status === 'ausstehend') e.status = 'abgelehnt';
        }
        saveDB(db);
      }

      const m = i.guild?.members.cache.get(uid);
      if (m) await dmAbgelehnt(i.guild, m);

      const allTexts = i.message.components[0]?.components
        ?.filter(c => c.type === ComponentType.TextDisplay)
        ?.map(c => c.content) ?? [];
      const keepTexts = allTexts.slice(0, -1);

      const updatedContainer = new ContainerBuilder()
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(makeText('## Abgelehnter Urlaubsantrag'))
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`leave_status_noop_abgelehnt_${Date.now()}`)
                .setLabel('Abgelehnt')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(true)
            )
        );

      for (const text of keepTexts) {
        updatedContainer
          .addSeparatorComponents(makeSeparator())
          .addTextDisplayComponents(makeText(text));
      }

      updatedContainer
        .addSeparatorComponents(makeSeparator())
        .addTextDisplayComponents(makeText(`> **Bearbeitet von:** ${i.user}`))
        .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

      await i.message.edit({ components: [updatedContainer], flags: CV2_FLAG });
      return i.reply({ content: 'Antrag abgelehnt!', ephemeral: true });
    }
  }

  if (id.startsWith('la_start_')) {
    if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
    return i.showModal(
      new ModalBuilder().setCustomId(`m_la_start_${id.slice(9)}`).setTitle('Urlaub starten')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dauer').setLabel('Dauer').setPlaceholder('1d  |  2w  |  1m').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('grund').setLabel('Begründung (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)),
        ),
    );
  }

  if (id.startsWith('la_end_')) {
    if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
    return i.showModal(
      new ModalBuilder().setCustomId(`m_la_end_${id.slice(7)}`).setTitle('Aktiven Urlaub beenden')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bestaetigung').setLabel('Bestätigung').setPlaceholder("Gib 'BEENDEN' ein").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7)),
        ),
    );
  }

  if (id.startsWith('la_ext_')) {
    if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
    return i.showModal(
      new ModalBuilder().setCustomId(`m_la_ext_${id.slice(7)}`).setTitle('Urlaub verlängern')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('zusatz').setLabel('Verlängerung').setPlaceholder('1d  |  1w  |  1m').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
        ),
    );
  }

  if (id.startsWith('la_hist_')) {
    const uid    = id.slice(8);
    const db     = loadDB();
    const eintr  = db.leave[uid]?.eintraege ?? [];
    const zeilen = eintr.map((e, n) =>
      `${n + 1}. ${datumDe(e.zeitstempel)} — ${formatDauer(e.dauer ?? '?')} — \`${e.status}\``
    );
    const container = new ContainerBuilder()
      .addTextDisplayComponents(makeText('## Urlaubshistorie'))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(zeilen.join('\n') || 'Keine Einträge.'))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
    return i.reply({ components: [container], flags: CV2_FLAG, ephemeral: true });
  }

  if (id.startsWith('sa_')) {
    if (!isLeitungsebene(i.member)) return i.reply({ content: 'Fehler: `Leitungsebene` benötigt!', ephemeral: true });
    const action = id.split('_')[1];
    const uid    = id.split('_').slice(2).join('_');
    const db     = loadDB();

    if (action === 'start') {
      if (db.shifts[uid]?.status === 'aktiv') return i.reply({ content: 'Fehler: Shift bereits aktiv!', ephemeral: true });
      const mName = i.guild?.members.cache.get(uid)?.displayName ?? uid;
      db.shifts[uid] = { status: 'aktiv', start_zeit: now, pause_start: null, gesamt_pause_sekunden: 0, gespeicherte_sekunden: 0, benutzername: mName };
      db.notified.shift_anomalie[uid] = false;
      saveDB(db);
      return i.reply({ content: `Shift für <@${uid}> gestartet.`, ephemeral: true });
    }

    if (action === 'pause') {
      const s = db.shifts[uid];
      if (!s || s.status !== 'aktiv') return i.reply({ content: 'Fehler: Shift nicht aktiv!', ephemeral: true });
      s.status = 'pausiert'; s.pause_start = now;
      saveDB(db);
      return i.reply({ content: `Shift pausiert.`, ephemeral: true });
    }

    if (action === 'end') {
      const s = db.shifts[uid];
      if (!s) return i.reply({ content: 'Fehler: Kein aktiver Shift!', ephemeral: true });
      let pause = s.gesamt_pause_sekunden ?? 0;
      if (s.status === 'pausiert') pause += now - (s.pause_start ?? now);
      const gesamt = Math.max(0, (s.gespeicherte_sekunden ?? 0) + (now - (s.start_zeit ?? now)) - pause);
      ensureUser(db, uid);
      db.users[uid].gesamt_shift_sekunden += gesamt;
      db.users[uid].shift_anzahl          += 1;
      db.users[uid].laengste_shift_sekunden = Math.max(db.users[uid].laengste_shift_sekunden ?? 0, gesamt);
      delete db.notified.shift_anomalie[uid];
      delete db.shifts[uid];
      saveDB(db);
      return i.reply({ content: `Shift beendet (+${formatDuration(gesamt)}).`, ephemeral: true });
    }

    if (action === 'edit') {
      return i.showModal(
        new ModalBuilder().setCustomId(`m_sa_edit_${uid}`).setTitle('Schicht bearbeiten')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('wert').setLabel('Zeit anpassen (HH:MM)').setPlaceholder('+02:30 hinzufügen  |  -01:00 abziehen  |  =08:00 setzen').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10),
            ),
          ),
      );
    }

    if (action === 'del') {
      delete db.shifts[uid];
      delete db.notified.shift_anomalie[uid];
      saveDB(db);
      return i.reply({ content: `Aktive Shift von <@${uid}> gelöscht.`, ephemeral: true });
    }

    if (action === 'clear') {
      delete db.shifts[uid];
      delete db.notified.shift_anomalie[uid];
      ensureUser(db, uid);
      db.users[uid].gesamt_shift_sekunden   = 0;
      db.users[uid].shift_anzahl            = 0;
      db.users[uid].laengste_shift_sekunden = 0;
      saveDB(db);
      return i.reply({ content: `Alle Shiftdaten von <@${uid}> zurückgesetzt.`, ephemeral: true });
    }
  }

  if (id === 'reset_confirm') {
    if (!isAdmin(i.user.id)) return i.reply({ content: 'Fehler: `Administrator` benötigt!', ephemeral: true });

    const db  = loadDB();
    const cid = db.config.kanaele.backup;
    if (cid) {
      for (const g of client.guilds.cache.values()) {
        const ch = g.channels.cache.get(cid);
        if (ch?.isTextBased()) { await backupSenden(ch).catch(console.error); break; }
      }
    }

    for (const uid of Object.keys(db.users)) {
      db.users[uid].gesamt_shift_sekunden   = 0;
      db.users[uid].shift_anzahl            = 0;
      db.users[uid].tickets                 = 0;
      db.users[uid].laengste_shift_sekunden = 0;
    }
    db.shifts = {};
    db.notified.shift_anomalie = {};
    saveDB(db);

    const container = new ContainerBuilder()
      .addTextDisplayComponents(makeText('## Gehalt zurückgesetzt'))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(
        '> Alle Schichtzeiten und Ticket-Zähler wurden zurückgesetzt.\n'
        + (cid ? '> Ein Backup wurde automatisch erstellt.' : '')
      ))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
    return i.update({ components: [container], flags: CV2_FLAG });
  }

  if (id === 'reset_cancel') {
    const container = new ContainerBuilder()
      .addTextDisplayComponents(makeText('## Abgebrochen'))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText('Es wurden keine Daten verändert.'))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));
    return i.update({ components: [container], flags: CV2_FLAG });
  }
}

// ────────────────────────────────────────────────────────────────────
//  MODAL HANDLER
// ────────────────────────────────────────────────────────────────────
async function handleModal(i) {
  const id = i.customId;

  if (id === 'm_ticket') {
    const db  = loadDB();
    const cid = db.config.kanaele.dokumentationen;
    if (!cid) return i.reply({ content: 'Fehler: `Dokumentationskanal` nicht konfiguriert!', ephemeral: true });
    const kanal = i.guild.channels.cache.get(cid);
    if (!kanal) return i.reply({ content: 'Fehler: `Dokumentationskanal` nicht gefunden!', ephemeral: true });

    const ticketName = i.fields.getTextInputValue('ticket_name');
    const worum      = i.fields.getTextInputValue('worum');
    const probleme   = i.fields.getTextInputValue('probleme');

    const container = new ContainerBuilder()
      .addTextDisplayComponents(makeText('## Dokumentation'))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(
        `> **Mitarbeiter:** ${i.user} \`(${i.user.username})\`\n`
        + `> **Ticket:** \`${ticketName}\``
      ))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(`**Worum ging es?**\n\`\`\`${worum}\`\`\``))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(`**Gab es Probleme?**\n\`\`\`${probleme}\`\`\``))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

    await kanal.send({ components: [container], flags: CV2_FLAG });

    const uid = String(i.user.id);
    ensureUser(db, uid);
    db.users[uid].tickets      = (db.users[uid].tickets ?? 0) + 1;
    db.users[uid].benutzername = i.member.displayName;
    saveDB(db);

    const bestContainer = new ContainerBuilder()
      .addTextDisplayComponents(makeText('## Dokumentation eingereicht'))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(
        `Deine Dokumentation \`${ticketName}\` wurde erfolgreich gespeichert.\n`
        + `> **Bearbeitete Tickets:** \`${db.users[uid].tickets}\``
      ))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

    return i.reply({ components: [bestContainer], flags: CV2_FLAG, ephemeral: true });
  }

  if (id === 'm_urlaub_antrag') {
    await i.deferReply({ ephemeral: true });

    const db  = loadDB();
    const uid = String(i.user.id);

    const blockierung = hatAktivenOderAusstehendUrlaub(db, uid);
    if (blockierung === 'aktiv') {
      return i.followUp({ content: '> Du hast bereits einen **aktiven Urlaub**. Wende dich an die Leitungsebene.', ephemeral: true });
    }
    if (blockierung === 'ausstehend') {
      return i.followUp({ content: '> Du hast bereits einen **ausstehenden Antrag**. Warte bis dieser bearbeitet wurde.', ephemeral: true });
    }

    const cid = db.config.kanaele.urlaubsantraege;
    if (!cid) return i.followUp({ content: 'Fehler: `Urlaubsantraege-Kanal` nicht konfiguriert!', ephemeral: true });
    const kanal = i.guild.channels.cache.get(cid);
    if (!kanal) return i.followUp({ content: 'Fehler: Kanal nicht gefunden!', ephemeral: true });

    const begruendung = i.fields.getTextInputValue('begruendung');
    const dauer       = i.fields.getTextInputValue('dauer');
    const durSek      = dauerZuSekunden(dauer);
    const ts          = nowTs();
    const endTs       = ts + durSek;

    if (!db.leave[uid]) db.leave[uid] = { eintraege: [], aktiv: [] };
    db.leave[uid].eintraege.push({ dauer, zeitstempel: ts, end_zeitstempel: endTs, status: 'ausstehend' });
    saveDB(db);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gen_approve_${uid}_${dauer}_${durSek}`).setLabel('Genehmigen').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gen_reject_${uid}_${dauer}_${durSek}`).setLabel('Ablehnen').setStyle(ButtonStyle.Danger),
    );

    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(makeText('## Ausstehender Urlaubsantrag'))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`leave_status_noop_ausstehend_${Date.now()}`)
              .setLabel('Ausstehend')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true)
          )
      )
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(`> **Antragsteller:** ${i.user} (\`${i.user.username}\`)`))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(
        `**Urlaubsinformationen**\n`
        + `> **Dauer:** ${formatDauer(dauer)}\n`
        + `> **Ende:** ${tsDisc(endTs, 'F')}`
      ))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(`**Begründung**\n\`\`\`${begruendung}\`\`\``))
      .addSeparatorComponents(makeSeparator())
      .addActionRowComponents(row);

    const pingIds = db.config.rollen.leitungsebene ?? [];
    if (pingIds.length) {
      container.addTextDisplayComponents(makeText(pingIds.map(rid => `<@&${rid}>`).join(' ')));
    }
    container.addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

    await kanal.send({ components: [container], flags: CV2_FLAG });
    await dmAusstehend(i.guild, i.member, dauer, endTs);

    const bestaetigung = new ContainerBuilder()
      .addTextDisplayComponents(makeText('## Antrag abgeschickt'))
      .addSeparatorComponents(makeSeparator())
      .addTextDisplayComponents(makeText(
        '> Dein Urlaubsantrag wurde erfolgreich abgeschickt.\n'
        + '> Du erhältst eine DM sobald er bearbeitet wurde.'
      ))
      .addTextDisplayComponents(makeText(`-# ${FOOTER_TEXT}`));

    return i.followUp({ components: [bestaetigung], flags: CV2_FLAG, ephemeral: true });
  }

  if (id.startsWith('m_la_start_')) {
    const uid    = id.slice(11);
    const dauer  = i.fields.getTextInputValue('dauer');
    const durSek = dauerZuSekunden(dauer);
    const ts     = nowTs();
    const endTs  = ts + durSek;
    const db     = loadDB();
    if (!db.leave[uid]) db.leave[uid] = { eintraege: [], aktiv: [] };
    db.leave[uid].eintraege.push({ dauer, zeitstempel: ts, start_zeitstempel: ts, end_zeitstempel: endTs, status: 'genehmigt' });
    db.leave[uid].aktiv.push({ dauer, start_zeitstempel: ts, end_zeitstempel: endTs, benutzername: i.guild?.members.cache.get(uid)?.displayName ?? '' });
    ensureUser(db, uid);
    db.users[uid].urlaubstage = (db.users[uid].urlaubstage ?? 0) + dauerZuTage(dauer);
    delete db.notified.urlaub_ende[uid];
    saveDB(db);
    const m = i.guild?.members.cache.get(uid);
    if (m) await dmGenehmigt(i.guild, m, dauer, endTs);
    return i.reply({ content: `Urlaub für <@${uid}> gestartet (${formatDauer(dauer)}). Endet ${tsDisc(endTs, 'F')}.`, ephemeral: true });
  }

  if (id.startsWith('m_la_end_')) {
    const uid  = id.slice(9);
    const best = i.fields.getTextInputValue('bestaetigung');
    if (best.toUpperCase() !== 'BEENDEN') return i.reply({ content: 'Fehler: Bestätigungswort falsch!', ephemeral: true });
    const db    = loadDB();
    const aktiv = db.leave[uid]?.aktiv ?? [];
    if (!aktiv.length) return i.reply({ content: 'Fehler: Kein aktiver Urlaub!', ephemeral: true });
    const startTs = aktiv[0].start_zeitstempel ?? nowTs();
    db.leave[uid].aktiv = aktiv.slice(1);
    delete db.notified.urlaub_ende[uid];
    saveDB(db);
    const m = i.guild?.members.cache.get(uid);
    if (m) await dmBeendet(i.guild, m, startTs);
    return i.reply({ content: `Urlaub von <@${uid}> beendet.`, ephemeral: true });
  }

  if (id.startsWith('m_la_ext_')) {
    const uid    = id.slice(9);
    const zusatz = i.fields.getTextInputValue('zusatz');
    const db     = loadDB();
    const aktiv  = db.leave[uid]?.aktiv ?? [];
    if (!aktiv.length) return i.reply({ content: 'Fehler: Kein aktiver Urlaub!', ephemeral: true });
    aktiv[0].end_zeitstempel = (aktiv[0].end_zeitstempel ?? nowTs()) + dauerZuSekunden(zusatz);
    db.leave[uid].aktiv = aktiv;
    delete db.notified.urlaub_ende[uid];
    saveDB(db);
    const m = i.guild?.members.cache.get(uid);
    if (m) await dmGenehmigt(i.guild, m, zusatz, aktiv[0].end_zeitstempel);
    return i.reply({ content: `Urlaub von <@${uid}> um **${formatDauer(zusatz)}** verlängert. Neues Ende: ${tsDisc(aktiv[0].end_zeitstempel, 'F')}`, ephemeral: true });
  }

  if (id.startsWith('m_sa_edit_')) {
    const uid = id.slice(10);
    const raw = i.fields.getTextInputValue('wert');
    let modus, sekunden;
    try { ({ modus, sekunden } = parseZeitEingabe(raw)); }
    catch (e) { return i.reply({ content: `Fehler: \`${e.message}\` — Bitte Format \`+HH:MM\`, \`-HH:MM\` oder \`=HH:MM\` verwenden.`, ephemeral: true }); }
    const db = loadDB();
    ensureUser(db, uid);
    const vorher = db.users[uid].gesamt_shift_sekunden ?? 0;
    if (modus === '=') db.users[uid].gesamt_shift_sekunden = sekunden;
    else db.users[uid].gesamt_shift_sekunden = Math.max(0, vorher + (modus === '+' ? sekunden : -sekunden));
    saveDB(db);
    const aktion = modus === '=' ? 'gesetzt auf' : modus === '+' ? 'hinzugefügt' : 'abgezogen';
    return i.reply({ content: `**${formatDuration(sekunden)}** ${aktion}. Neu: **${formatDuration(db.users[uid].gesamt_shift_sekunden)}**`, ephemeral: true });
  }
}

// ────────────────────────────────────────────────────────────────────
//  KEEP-ALIVE
// ────────────────────────────────────────────────────────────────────
const app = express();
app.get('/', (_req, res) => res.send('HHB Gehalt läuft!'));
app.get('/health', (_req, res) => res.json({
  status:     'healthy',
  bot:        client.user?.tag ?? 'starting',
  latency_ms: Math.round(client.ws.ping),
  timestamp:  new Date().toISOString(),
}));
const PORT = parseInt(process.env.PORT ?? '8080');
app.listen(PORT, () => console.log(`[Express] Keep-alive auf Port ${PORT}`));

if (!TOKEN) {
  console.error('[FEHLER] BOT_TOKEN nicht gesetzt!');
  process.exit(1);
}

client.login(TOKEN);
