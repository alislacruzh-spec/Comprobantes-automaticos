// ==UserScript==
// @name         P2P Banesco+Binance – Captura y Marcar Pagado 5.1
// @namespace    p2p-banesco-binance
// @version      5.1.1
// @updateURL    https://raw.githubusercontent.com/alislacruzh-spec/Comprobantes-automaticos/main/comprobantes_automaticos.user.js
// @downloadURL  https://raw.githubusercontent.com/alislacruzh-spec/Comprobantes-automaticos/main/comprobantes_automaticos.user.js
// @match        https://www.banesconline.com/*
// @match        https://c2c-admin.binance.com/es/order/pending*
// @match        https://p2p.binance.com/*
// @match        https://www.binance.com/es/p2p/*
// @match        https://www.binance.com/*/p2p/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.telegram.org
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// ==/UserScript==

(function () {
    "use strict";

    /* ============================================
       TELEGRAM (OPCIONAL) — configurable desde el propio navegador
       No hay datos de ningún bot escritos en el código. Cada persona abre
       el panel de configuración y pone los de SU bot:
         • Botón ✈️ en el borde izquierdo de la pantalla (Banesco o Binance)
         • Atajo Alt+T
         • Menú de Tampermonkey → "⚙️ Configurar Telegram"
       Si Telegram está desactivado o sin datos, el script funciona igual
       (captura, marca pagado y envía el comprobante al chat de Binance);
       solo se omite la copia a Telegram.
       Los datos se guardan en el almacenamiento de Tampermonkey de ESE
       navegador; no se comparten al copiar el archivo del script.
    ============================================ */
    const TG_CONFIG_KEY      = 'p2p_tg_config';
    const TOPIC_CACHE_PREFIX = 'p2p_telegram_topic_';

    function leerConfigTG() {
        const def = { activo: false, token: '', chatId: '', temasPorDia: false };
        try { return Object.assign(def, JSON.parse(GM_getValue(TG_CONFIG_KEY, '{}') || '{}')); }
        catch (_) { return def; }
    }
    function guardarConfigTG(cfg) { GM_setValue(TG_CONFIG_KEY, JSON.stringify(cfg)); }

    // Telegram solo se usa si está ACTIVADO y tiene token + chat ID.
    function telegramActivo() {
        const c = leerConfigTG();
        return !!(c.activo && c.token && c.chatId);
    }

    // Llamada genérica a la API de Telegram → callback(json | null, errorTexto)
    function tgApi(token, metodo, datos, callback, esFormData = false) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `https://api.telegram.org/bot${token}/${metodo}`,
            headers: esFormData ? undefined : { 'Content-Type': 'application/json' },
            data: esFormData ? datos : JSON.stringify(datos || {}),
            onload: (resp) => {
                try {
                    const json = JSON.parse(resp.responseText);
                    callback(json, json.ok ? null : json.description);
                } catch (_) { callback(null, 'Respuesta inesperada de Telegram'); }
            },
            onerror: () => callback(null, 'No se pudo conectar con Telegram'),
            ontimeout: () => callback(null, 'Tiempo de espera agotado'),
        });
    }

    /* ── TEMAS POR DÍA (opcional, solo grupos con "Temas" activados) ──
       Cada día se crea (una sola vez) un tema con la fecha y los recibos de
       ese día van dentro. Si está desactivado, o el chat no admite temas,
       los mensajes van al chat normal. */
    function obtenerFechaKeyHoy() {
        const partes = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date());
        const map = {};
        partes.forEach(p => { map[p.type] = p.value; });
        return `${map.year}-${map.month}-${map.day}`;
    }

    function nombreTemaDesdeFechaKey(fechaKey) {
        const [y, m, d] = fechaKey.split('-');
        return `📅 ${d}/${m}/${y}`;
    }

    function obtenerOCrearTemaDelDia(callback) {
        const cfg = leerConfigTG();
        if (!telegramActivo() || !cfg.temasPorDia) { callback(null); return; }

        const fechaKey = obtenerFechaKeyHoy();
        const cacheKey = TOPIC_CACHE_PREFIX + cfg.chatId + '_' + fechaKey;
        const idGuardado = GM_getValue(cacheKey, null);
        if (idGuardado === 'sin_temas') { callback(null); return; }
        if (idGuardado) { callback(idGuardado); return; }

        tgApi(cfg.token, 'createForumTopic', { chat_id: cfg.chatId, name: nombreTemaDesdeFechaKey(fechaKey) }, (json, err) => {
            if (json && json.ok) {
                const topicId = json.result.message_thread_id;
                GM_setValue(cacheKey, topicId);
                console.log('[Telegram] Tema del día creado → id', topicId);
                callback(topicId);
            } else {
                // No reintentar en todo el día: se envía al chat normal.
                GM_setValue(cacheKey, 'sin_temas');
                console.warn('[Telegram] No se pudo crear el tema del día:', err);
                mostrarNotif('⚠️ Telegram: no se pudo crear el tema del día (' + err + '). Se envía al chat normal.', '#7a5a00');
                callback(null);
            }
        });
    }

    function enviarReciboATelegram(blob, caption, topicId) {
        if (!telegramActivo()) return;
        const cfg = leerConfigTG();
        const formData = new FormData();
        formData.append('chat_id', cfg.chatId);
        formData.append('caption', caption || '');
        formData.append('photo', blob, 'recibo.png');
        if (topicId) formData.append('message_thread_id', topicId);

        tgApi(cfg.token, 'sendPhoto', formData, (json, err) => {
            if (json && json.ok) console.log('[Telegram] ✅ Recibo guardado en Telegram');
            else {
                console.error('[Telegram] Error:', err);
                mostrarNotif('⚠️ Error al guardar en Telegram: ' + err, '#7a5a00');
            }
        }, true);
    }

    // Mensaje de TEXTO aparte con todos los datos del recibo (queda buscable).
    function enviarTextoATelegram(texto, topicId) {
        if (!telegramActivo()) return;
        const cfg = leerConfigTG();
        const body = { chat_id: cfg.chatId, text: texto };
        if (topicId) body.message_thread_id = topicId;
        tgApi(cfg.token, 'sendMessage', body, (json, err) => {
            if (json && json.ok) console.log('[Telegram] ✅ Datos del recibo guardados');
            else console.error('[Telegram] Error (texto):', err);
        });
    }

    /* ============================================
       PANEL DE CONFIGURACIÓN DE TELEGRAM
       (Shadow DOM para que los estilos de Banesco/Binance no lo afecten)
    ============================================ */
    function abrirPanelTelegram() {
        if (document.getElementById('p2p-tg-host')) return;
        const cfg = leerConfigTG();

        const host = document.createElement('div');
        host.id = 'p2p-tg-host';
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
<style>
  *{box-sizing:border-box;font-family:Arial,Helvetica,sans-serif}
  .fondo{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
  .caja{background:#fff;color:#1e2329;width:100%;max-width:440px;border-radius:12px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.35);max-height:90vh;overflow:auto}
  h2{margin:0 0 4px;font-size:18px}
  .sub{margin:0 0 16px;font-size:13px;color:#707a8a;line-height:1.4}
  .fila{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border-radius:8px;background:#f5f5f5;margin-bottom:14px}
  .fila b{font-size:14px}
  .estado{font-size:12px;color:#707a8a}
  .sw{position:relative;width:48px;height:26px;flex:none}
  .sw input{opacity:0;width:0;height:0}
  .sl{position:absolute;inset:0;background:#c4c8ce;border-radius:26px;cursor:pointer;transition:.2s}
  .sl:before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
  .sw input:checked + .sl{background:#2ebd85}
  .sw input:checked + .sl:before{transform:translateX(22px)}
  label.campo{display:block;font-size:13px;font-weight:bold;margin:10px 0 4px}
  .inp{display:flex;gap:6px}
  input[type=text],input[type=password]{flex:1;width:100%;padding:9px 10px;border:1px solid #d0d4da;border-radius:6px;font-size:14px;color:#1e2329;background:#fff}
  input:focus{outline:2px solid #fcd535;border-color:#fcd535}
  .chk{display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:12px 0 4px;line-height:1.35}
  button{border:0;border-radius:6px;padding:9px 14px;font-size:14px;cursor:pointer;font-weight:bold}
  .mini{padding:8px 10px;font-size:12px;background:#eaecef;color:#1e2329;font-weight:normal;white-space:nowrap}
  .acciones{display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}
  .prim{background:#fcd535;color:#1e2329}
  .sec{background:#eaecef;color:#1e2329}
  .msg{margin-top:12px;font-size:13px;min-height:18px;line-height:1.4;white-space:pre-wrap}
  .ok{color:#1a7a1a}.err{color:#c0392b}
  details{margin-top:14px;font-size:12px;color:#474d57;line-height:1.5}
  summary{cursor:pointer;font-weight:bold}
  ol{padding-left:18px;margin:6px 0}
  .chats button{display:block;width:100%;text-align:left;margin-top:6px;background:#f5f5f5;font-weight:normal;font-size:13px}
</style>
<div class="fondo">
  <div class="caja" role="dialog" aria-label="Configurar Telegram">
    <h2>✈️ Telegram – copia de comprobantes</h2>
    <p class="sub">Opcional. Si lo dejas desactivado, el script sigue funcionando igual; solo no se guarda copia en Telegram.</p>

    <div class="fila">
      <div><b>Enviar comprobantes a Telegram</b><div class="estado" id="estado"></div></div>
      <label class="sw"><input type="checkbox" id="activo"><span class="sl"></span></label>
    </div>

    <label class="campo" for="token">Token del bot</label>
    <div class="inp">
      <input type="password" id="token" placeholder="123456789:ABCdef..." autocomplete="off" spellcheck="false">
      <button class="mini" id="ver" type="button">Ver</button>
    </div>

    <label class="campo" for="chat">Chat ID</label>
    <div class="inp">
      <input type="text" id="chat" placeholder="ej: 123456789 o -100..." autocomplete="off" spellcheck="false">
      <button class="mini" id="detectar" type="button">Detectar</button>
    </div>
    <div class="chats" id="chats"></div>

    <label class="chk"><input type="checkbox" id="temas">
      <span>Crear un tema por día (solo grupos con <i>Temas</i> activados y el bot como administrador)</span></label>

    <div class="msg" id="msg"></div>

    <div class="acciones">
      <button class="sec" id="probar" type="button">Probar envío</button>
      <button class="sec" id="cerrar" type="button">Cerrar</button>
      <button class="prim" id="guardar" type="button">Guardar</button>
    </div>

    <details>
      <summary>¿Cómo obtengo el token y el Chat ID?</summary>
      <ol>
        <li>En Telegram busca <b>@BotFather</b>, envía <b>/newbot</b> y sigue los pasos. Te dará el <b>token</b>.</li>
        <li>Pega el token arriba.</li>
        <li>Abre tu bot en Telegram y envíale cualquier mensaje (ej. "hola"). Si usarás un grupo, agrega el bot al grupo y escribe algo allí.</li>
        <li>Pulsa <b>Detectar</b> y elige tu chat de la lista.</li>
        <li>Activa el interruptor, pulsa <b>Probar envío</b> y luego <b>Guardar</b>.</li>
      </ol>
    </details>
  </div>
</div>`;
        document.body.appendChild(host);

        const $ = (id) => root.getElementById(id);
        const activo = $('activo'), token = $('token'), chat = $('chat'), temas = $('temas');
        const msg = $('msg'), estado = $('estado');
        activo.checked = !!cfg.activo;
        token.value = cfg.token || '';
        chat.value = cfg.chatId || '';
        temas.checked = !!cfg.temasPorDia;

        const leerForm = () => ({
            activo: activo.checked,
            token: token.value.trim(),
            chatId: chat.value.trim(),
            temasPorDia: temas.checked,
        });
        const ponerMsg = (t, tipo = '') => { msg.textContent = t; msg.className = 'msg ' + tipo; };
        const pintarEstado = () => {
            const f = leerForm();
            estado.textContent = !f.activo ? 'Desactivado'
                : (!f.token || !f.chatId) ? 'Activado, pero faltan datos (no se enviará)'
                : 'Activado';
        };
        pintarEstado();
        [activo, token, chat].forEach(el => el.addEventListener('input', pintarEstado));
        activo.addEventListener('change', pintarEstado);

        // Evitar que los atajos de la página reciban lo que se escribe aquí
        root.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') cerrar(); });

        const cerrar = () => host.remove();
        $('cerrar').onclick = cerrar;
        root.querySelector('.fondo').addEventListener('click', (e) => { if (e.target.classList.contains('fondo')) cerrar(); });
        $('ver').onclick = () => {
            token.type = token.type === 'password' ? 'text' : 'password';
            $('ver').textContent = token.type === 'password' ? 'Ver' : 'Ocultar';
        };

        $('guardar').onclick = () => {
            const f = leerForm();
            if (f.token && !/^\d+:[\w-]{20,}$/.test(f.token)) {
                ponerMsg('El token no tiene el formato esperado (números:letras).', 'err');
                return;
            }
            const anterior = leerConfigTG();
            guardarConfigTG(f);
            if (anterior.chatId !== f.chatId) {
                // Al cambiar de chat, limpiar el tema "sin_temas"/id del día anterior
                GM_setValue(TOPIC_CACHE_PREFIX + f.chatId + '_' + obtenerFechaKeyHoy(), null);
            }
            ponerMsg('✅ Guardado.', 'ok');
            mostrarNotif(f.activo && f.token && f.chatId ? '✈️ Telegram activado' : '✈️ Telegram desactivado — el script sigue funcionando normal', '#1a4a7a');
            actualizarBotonTG();
            setTimeout(cerrar, 700);
        };

        $('probar').onclick = () => {
            const f = leerForm();
            if (!f.token || !f.chatId) { ponerMsg('Completa el token y el Chat ID para probar.', 'err'); return; }
            ponerMsg('Enviando mensaje de prueba…');
            tgApi(f.token, 'sendMessage', {
                chat_id: f.chatId,
                text: '✅ Prueba del script P2P Banesco+Binance — ' + new Date().toLocaleString('es-VE'),
            }, (json, err) => {
                if (json && json.ok) ponerMsg('✅ Mensaje de prueba enviado. Revisa tu Telegram y pulsa Guardar.', 'ok');
                else ponerMsg('❌ ' + (err || 'Error') + '\nRevisa el token, el Chat ID y que le hayas escrito al bot.', 'err');
            });
        };

        $('detectar').onclick = () => {
            const tk = token.value.trim();
            const lista = $('chats');
            lista.innerHTML = '';
            if (!tk) { ponerMsg('Primero pega el token del bot.', 'err'); return; }
            ponerMsg('Buscando chats donde le escribiste al bot…');
            tgApi(tk, 'getUpdates', {}, (json, err) => {
                if (!json || !json.ok) { ponerMsg('❌ ' + (err || 'Error') + '\nRevisa el token.', 'err'); return; }
                const vistos = new Map();
                for (const u of json.result || []) {
                    const m = u.message || u.channel_post || u.my_chat_member || u.edited_message;
                    const c = m && m.chat;
                    if (c && !vistos.has(c.id)) vistos.set(c.id, c);
                }
                if (!vistos.size) {
                    ponerMsg('No se encontraron chats. Envíale un mensaje al bot (o escribe en el grupo donde está) y vuelve a pulsar Detectar.', 'err');
                    return;
                }
                ponerMsg('Elige tu chat:');
                for (const c of vistos.values()) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    const nombre = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || 'Chat';
                    b.textContent = `${c.type === 'private' ? '👤' : '👥'} ${nombre} — ${c.id}`;
                    b.onclick = () => {
                        chat.value = String(c.id);
                        if (c.is_forum) temas.checked = true;
                        lista.innerHTML = '';
                        pintarEstado();
                        ponerMsg('Chat seleccionado. Activa el interruptor, prueba y guarda.', 'ok');
                    };
                    lista.appendChild(b);
                }
            });
        };

        setTimeout(() => (token.value ? activo : token).focus(), 50);
    }

    // Botón flotante ✈️ en el borde izquierdo (verde = activo, gris = apagado)
    function actualizarBotonTG() {
        const b = document.getElementById('p2p-tg-btn');
        if (!b) return;
        const on = telegramActivo();
        b.style.background = on ? '#229ED9' : '#707a8a';
        b.title = 'Telegram: ' + (on ? 'ACTIVADO' : 'desactivado') + ' — clic para configurar (Alt+T) · arrástrame para moverme · doble clic: posición inicial';
    }
    /* Botón ✈️ ARRASTRABLE: mantenlo presionado y muévelo a donde no
       estorbe. La posición se guarda por sitio (Banesco y Binance por
       separado). Un clic sin arrastrar abre el panel.
       Doble clic → vuelve a la posición inicial. */
    const POS_BTN_KEY = 'p2p_tg_btn_pos_' + location.hostname;

    function aplicarPosBoton(b, pos) {
        const w = 34, h = 34;
        const x = Math.min(Math.max(0, pos.x), window.innerWidth - w);
        const y = Math.min(Math.max(0, pos.y), window.innerHeight - h);
        b.style.left = x + 'px';
        b.style.top  = y + 'px';
    }

    function crearBotonTG() {
        if (window.top !== window.self || document.getElementById('p2p-tg-btn') || !document.body) return;
        const b = document.createElement('div');
        b.id = 'p2p-tg-btn';
        b.textContent = '✈️';
        b.style.cssText = 'position:fixed;z-index:2147483645;width:34px;height:34px;' +
            'display:flex;align-items:center;justify-content:center;font-size:16px;cursor:grab;' +
            'border-radius:50%;opacity:.8;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none;touch-action:none;';

        const posDefecto = { x: 0, y: Math.round(window.innerHeight * 0.45) };
        let pos;
        try { pos = JSON.parse(GM_getValue(POS_BTN_KEY, '') || 'null') || posDefecto; } catch (_) { pos = posDefecto; }
        aplicarPosBoton(b, pos);

        let arrastrando = false, movido = false, offX = 0, offY = 0, inicioX = 0, inicioY = 0;
        b.addEventListener('pointerdown', (e) => {
            arrastrando = true; movido = false;
            inicioX = e.clientX; inicioY = e.clientY;
            const r = b.getBoundingClientRect();
            offX = e.clientX - r.left; offY = e.clientY - r.top;
            b.setPointerCapture(e.pointerId);
            b.style.cursor = 'grabbing';
            e.preventDefault();
        });
        b.addEventListener('pointermove', (e) => {
            if (!arrastrando) return;
            if (Math.abs(e.clientX - inicioX) + Math.abs(e.clientY - inicioY) > 4) movido = true;
            if (movido) aplicarPosBoton(b, { x: e.clientX - offX, y: e.clientY - offY });
        });
        b.addEventListener('pointerup', (e) => {
            if (!arrastrando) return;
            arrastrando = false;
            b.style.cursor = 'grab';
            try { b.releasePointerCapture(e.pointerId); } catch (_) {}
            if (movido) {
                GM_setValue(POS_BTN_KEY, JSON.stringify({ x: parseInt(b.style.left), y: parseInt(b.style.top) }));
            } else {
                abrirPanelTelegram();
            }
        });
        b.addEventListener('dblclick', () => {
            GM_setValue(POS_BTN_KEY, '');
            aplicarPosBoton(b, posDefecto);
        });
        // Si la ventana se achica, que el botón no quede fuera de la pantalla
        window.addEventListener('resize', () => aplicarPosBoton(b, { x: parseInt(b.style.left), y: parseInt(b.style.top) }));

        b.onmouseenter = () => { b.style.opacity = '1'; };
        b.onmouseleave = () => { b.style.opacity = '.8'; };
        document.body.appendChild(b);
        actualizarBotonTG();
    }

    function iniciarConfigTelegram() {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('⚙️ Configurar Telegram', abrirPanelTelegram);
        }
        document.addEventListener('keydown', (e) => {
            if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); abrirPanelTelegram(); }
        });
        if (document.body) crearBotonTG();
        else document.addEventListener('DOMContentLoaded', crearBotonTG);
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(TG_CONFIG_KEY, () => actualizarBotonTG());
        }
    }

    // Extrae el texto visible del recibo (beneficiario, cuenta/teléfono,
    // cédula, banco, monto, concepto — todo lo que Banesco ya muestra en la
    // pantalla de confirmación), limpio de líneas vacías repetidas.
    function extraerTextoLimpioRecibo(recibo) {
        const texto = (recibo.innerText || recibo.textContent || '');
        return texto
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0)
            .join('\n');
    }

    function blobADataUrl(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
        });
    }

    const esBanesco = location.hostname.includes('banesconline.com');
    const esBinance = location.hostname.includes('binance.com');

    // ─────────────────────────────────────────────
    //  UTILIDADES COMUNES
    // ─────────────────────────────────────────────

    // Reubicada a la esquina INFERIOR IZQUIERDA: la esquina superior (donde
    // estaba antes) queda encima del recibo/formulario de Banesco, y la
    // esquina inferior derecha la usa el botón "Forzar opc=30" del otro
    // script — así evitamos tapar contenido en ambos casos.
    function mostrarNotif(msg, color = '#1a7a1a') {
        document.getElementById('p2p-cap-notif')?.remove();
        const d = document.createElement('div');
        d.id = 'p2p-cap-notif';
        d.style.cssText = `
            position:fixed;bottom:20px;left:20px;z-index:999999;
            background:${color};color:#fff;font-family:Arial,sans-serif;
            font-size:15px;padding:14px 20px;border-radius:10px;
            box-shadow:0 4px 18px rgba(0,0,0,0.35);max-width:340px;
            line-height:1.5;
        `;
        d.textContent = msg;
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 5000);
    }

    iniciarConfigTelegram();

    // ─────────────────────────────────────────────
    //  MÓDULO BANESCO
    // ─────────────────────────────────────────────

    if (esBanesco) {

        function buscarElemento(selector) {
            const el = document.querySelector(selector);
            if (el) return el;
            for (const frame of document.querySelectorAll('iframe')) {
                try {
                    const doc = frame.contentDocument || frame.contentWindow?.document;
                    if (!doc) continue;
                    const el2 = doc.querySelector(selector);
                    if (el2) return el2;
                } catch (_) {}
            }
            return null;
        }

        function esOperacionExitosa(recibo) {
            const texto = recibo.innerText || recibo.textContent || '';
            return /operaci[oó]n\s+exitosa|transacci[oó]n\s+exitosa/i.test(texto);
        }

        /* ============================================
           ★ V4.6: DEDUP PERSISTENTE POR CONTENIDO DEL RECIBO
           El recibo confirma un pago único: número de referencia, cuenta,
           monto y fecha/hora — ese texto es, en la práctica, una huella
           irrepetible de ESA transacción puntual. La guardamos en GM storage
           (no en una variable en memoria) para que:
             • sobreviva a un recargo/refresh de la página (el motivo más
               común de reenvío: el DOM sigue mostrando "Operación Exitosa"
               de un pago YA procesado y el script, al reiniciarse, lo trata
               como nuevo).
             • sea compartida entre pestañas, ya que GM storage no es por
               pestaña sino global al script.
        ============================================ */
        const DEDUP_KEY     = 'p2p_ultimo_recibo_fingerprint';
        const DEDUP_TTL_MS  = 30 * 60 * 1000; // 30 min — pasado esto, se trata como recibo nuevo aunque coincida

        function calcularFingerprintRecibo(recibo) {
            // Primeros 500 caracteres del texto normalizado alcanzan para
            // identificar de forma práctica un recibo puntual (incluye
            // referencia, cuenta, monto y fecha/hora que Banesco siempre
            // muestra al inicio del recibo).
            return extraerTextoLimpioRecibo(recibo).slice(0, 500);
        }

        function reciboYaEnviado(fingerprint) {
            const guardado = GM_getValue(DEDUP_KEY, null);
            if (!guardado) return false;
            try {
                const { fp, ts } = JSON.parse(guardado);
                if (Date.now() - ts > DEDUP_TTL_MS) return false; // expiró
                return fp === fingerprint;
            } catch (_) {
                return false;
            }
        }

        function marcarReciboComoEnviado(fingerprint) {
            GM_setValue(DEDUP_KEY, JSON.stringify({ fp: fingerprint, ts: Date.now() }));
        }

        /* opts.forzarManual = true → Alt+S: ignora el dedup a propósito,
           por si el usuario realmente necesita reenviar (ej. para probar).
           La detección automática SIEMPRE respeta el dedup. */
        async function capturarYCopiar(opts = {}) {
            const { forzarManual = false } = opts;

            const recibo = buscarElemento('div.recibo') || buscarElemento('#pagina');

            if (!recibo) {
                mostrarNotif('⚠️ No se encontró el recibo en esta página', '#7a5a00');
                return;
            }

            const exitosa     = esOperacionExitosa(recibo);
            const fingerprint = calcularFingerprintRecibo(recibo);

            if (!forzarManual && reciboYaEnviado(fingerprint)) {
                console.log('[Captura] Recibo ya enviado anteriormente (fingerprint coincide) — se omite para evitar duplicado.');
                mostrarNotif('ℹ️ Este recibo ya se envió antes — se omite para evitar duplicados.', '#1a4a7a');
                return;
            }

            console.log('[Captura] Recibo encontrado:', recibo.id || recibo.className);
            console.log('[Captura] ¿Operación Exitosa?', exitosa);

            mostrarNotif('📸 Capturando recibo...', '#1a4a7a');

            // Se marca como "enviado" YA, antes del trabajo asíncrono, para
            // cerrar la ventana de carrera si dos disparadores llegan casi
            // al mismo tiempo (ej. auto-detección + Alt+S casi simultáneos,
            // o dos pestañas abiertas en el mismo recibo).
            marcarReciboComoEnviado(fingerprint);

            try {
                const canvas = await html2canvas(recibo, {
                    scale: 1,
                    allowTaint: true,
                    backgroundColor: '#ffffff',
                    logging: false,
                    imageTimeout: 0,
                    ignoreElements: (el) => el.classList.contains('botonesRboWrapper'),
                });

                canvas.toBlob(async (blob) => {
                    try {
                        await navigator.clipboard.write([
                            new ClipboardItem({ 'image/png': blob })
                        ]);
                        console.log('[Captura] ✅ Recibo copiado al portapapeles');
                    } catch (err) {
                        const url = URL.createObjectURL(blob);
                        window.open(url, '_blank');
                        mostrarNotif('⚠️ Portapapeles bloqueado — recibo abierto en nueva pestaña', '#7a5a00');
                    }

                    // Guardado automático en Telegram (no bloqueante — si falla
                    // o no está configurado, el resto del flujo sigue normal).
                    const fechaHora = new Date().toLocaleString('es-VE');
                    const ordenActual = GM_getValue('p2p_orden_actual', '');
                    const caption = (exitosa ? '✅ Operación Exitosa' : '⚠️ Sin confirmar') +
                        (ordenActual ? ' — Orden: ' + ordenActual : '') +
                        ' — ' + fechaHora;

                    // Mensaje de texto aparte con TODOS los datos que muestra
                    // el recibo (beneficiario, cuenta/teléfono, cédula, banco,
                    // monto, concepto) — así queda buscable por cualquiera de
                    // esos datos, no solo por el número de orden.
                    const datosRecibo = extraerTextoLimpioRecibo(recibo);
                    const mensajeDatos =
                        '📋 Datos de la transferencia\n' +
                        (ordenActual ? 'Orden: ' + ordenActual + '\n' : '') +
                        'Estado: ' + (exitosa ? '✅ Operación Exitosa' : '⚠️ Sin confirmar') + '\n' +
                        'Fecha: ' + fechaHora + '\n\n' +
                        datosRecibo;

                    // Primero nos aseguramos de tener el "tema" (carpeta) de
                    // hoy en Telegram, y recién entonces enviamos la foto y
                    // los datos dentro de ese tema.
                    if (telegramActivo()) {
                        obtenerOCrearTemaDelDia((topicId) => {
                            enviarReciboATelegram(blob, caption, topicId);
                            enviarTextoATelegram(mensajeDatos, topicId);
                        });
                    } else {
                        console.log('[Telegram] Desactivado o sin configurar — se omite la copia.');
                    }

                    if (exitosa) {
                        // ★ V4.7: la imagen viaja a Binance por GM storage
                        // (no por el portapapeles), así Binance no necesita
                        // tener el foco para leerla. Se guarda ANTES de la señal.
                        try {
                            const dataUrl = await blobADataUrl(blob);
                            GM_setValue('p2p_recibo_img', JSON.stringify({ ts: Date.now(), dataUrl }));
                        } catch (e) {
                            console.warn('[Captura] No se pudo guardar la imagen en storage:', e);
                        }
                        const payload = JSON.stringify({ ts: Date.now() });
                        GM_setValue('p2p_pago_exitoso', payload);
                        mostrarNotif('✅ Operación Exitosa — marcando como pagado en Binance…');
                        console.log('[Captura] Señal enviada a Binance');
                    } else {
                        mostrarNotif('⚠️ Recibo capturado pero NO se detectó "Operación Exitosa".', '#7a5a00');
                    }

                }, 'image/png');

            } catch (e) {
                console.error('[Captura]', e);
                mostrarNotif('❌ Error al capturar: ' + e.message, '#7a1a1a');
            }
        }

        /* ★ Corte rápido EN MEMORIA para no recalcular el fingerprint en
           cada tick del polling/observer una vez que ya disparamos en esta
           misma carga de página. El dedup persistente (arriba) es el que
           realmente evita el reenvío entre recargas/pestañas. */
        let autoCapturaEjecutada = false;

        function debounce(fn, ms) {
            let t;
            return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
        }

        /* Revisa si el recibo ya muestra "Operación Exitosa" y, de ser así,
           dispara la captura automáticamente — sin necesidad de Alt+S. */
        function evaluarYCapturarAuto() {
            if (autoCapturaEjecutada) return;

            const recibo = buscarElemento('div.recibo') || buscarElemento('#pagina');
            if (!recibo) return;
            if (!esOperacionExitosa(recibo)) return;

            autoCapturaEjecutada = true;
            console.log('[Auto] "Operación Exitosa" detectada automáticamente — capturando…');
            mostrarNotif('🔎 Operación Exitosa detectada — capturando automáticamente…', '#1a4a7a');
            capturarYCopiar(); // respeta el dedup persistente (forzarManual=false)
        }

        const evaluarYCapturarAutoDebounced = debounce(evaluarYCapturarAuto, 200);

        function registrarAtajo(doc) {
            doc.addEventListener('keydown', (e) => {
                if (e.altKey && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    // Manual: ignora el dedup a propósito (escape hatch si
                    // realmente necesitás reenviar el mismo recibo).
                    capturarYCopiar({ forzarManual: true });
                }
            });
        }

        /* Registra tanto el atajo manual Alt+S como el observer de
           auto-detección dentro de un documento (principal o iframe). */
        function registrarVigilancia(doc) {
            registrarAtajo(doc);
            try {
                const obs = new MutationObserver(() => evaluarYCapturarAutoDebounced());
                obs.observe(doc.body, { childList: true, subtree: true, characterData: true });
            } catch (_) {}
        }

        registrarVigilancia(document);
        document.querySelectorAll('iframe').forEach(frame => {
            try {
                const doc = frame.contentDocument || frame.contentWindow?.document;
                if (doc) { registrarVigilancia(doc); doc._p2pRegistrado = true; }
            } catch (_) {}
        });

        const observer = new MutationObserver(() => {
            document.querySelectorAll('iframe').forEach(frame => {
                try {
                    const doc = frame.contentDocument || frame.contentWindow?.document;
                    if (doc && !doc._p2pRegistrado) {
                        registrarVigilancia(doc);
                        doc._p2pRegistrado = true;
                    }
                } catch (_) {}
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Fallback: poll cada 1s por si algún cambio de recibo no dispara
        // el MutationObserver (ej. contenido inyectado sin mutar el DOM detectable).
        setInterval(evaluarYCapturarAuto, 500);

        // Chequeo inmediato por si el recibo ya está en pantalla al cargar el script.
        evaluarYCapturarAuto();

        console.log('[Banesco] Listo — detección automática activa (con dedup persistente) | Alt+S para forzar captura manual');
    }

    // ─────────────────────────────────────────────
    //  MÓDULO BINANCE
    // ─────────────────────────────────────────────

    if (esBinance) {

        /* ============================================
           Detección del número de orden actual, para poder incluirlo en el
           caption del recibo enviado a Telegram (y así poder buscarlo luego
           con el buscador nativo de Telegram dentro del chat).
           Se guarda en GM storage — al ser EL MISMO script el que corre en
           Banesco y en Binance, ambos lados comparten este valor aunque
           estén en pestañas/dominios distintos.
        ============================================ */
        const ORDEN_ID_SELECTORS = [
            '[data-bn-type="text"].css-14yjdiq',
            '[data-testid="order-number"]',
            '.order-number',
            '.css-14yjdiq',
            '[class*="orderNumber"]',
            '[class*="order-id"]',
            'span[class*="css-"][class*="number"]',
        ];

        function capturarNumeroOrden() {
            for (const sel of ORDEN_ID_SELECTORS) {
                try {
                    const el = document.querySelector(sel);
                    const txt = el && el.textContent.trim();
                    if (txt) return txt;
                } catch (_) {}
            }
            return null;
        }

        let ultimaOrdenGuardada = null;
        function actualizarOrdenSiCambio() {
            const orden = capturarNumeroOrden();
            if (orden && orden !== ultimaOrdenGuardada) {
                ultimaOrdenGuardada = orden;
                GM_setValue('p2p_orden_actual', orden);
                console.log('[Binance] Número de orden detectado (para Telegram):', orden);
            }
        }

        new MutationObserver(actualizarOrdenSiCambio).observe(document.body, { childList: true, subtree: true });
        setInterval(actualizarOrdenSiCambio, 1000);
        actualizarOrdenSiCambio();

        /* Colapsa &nbsp; y espacios múltiples, minúsculas, sin espacios extremos.
           El botón trae el timer pegado al texto ("Marcar como pagado 00:14:01"),
           así que normalizamos antes de comparar. */
        function normalizarEspacios(txt) {
            return (txt || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
        }

        function buscarBotonPagar() {
            // ── 1. Estrategia primaria ─────────────────────────────────────
            // El botón real es <button data-bn-type="button"> y su texto
            // (ignorando el timer que Binance concatena después) EMPIEZA con
            // "marcar como pagado". Esto evita falsos positivos con otros
            // elementos de la página que solo contienen la palabra "pagado"
            // (p.ej. etiquetas de estado en el historial de la orden).
            const candidatos = document.querySelectorAll('button[data-bn-type="button"]');
            for (const btn of candidatos) {
                if (btn.disabled) continue;
                const texto = normalizarEspacios(btn.textContent);
                if (texto.startsWith('marcar como pagado')) return btn;
            }

            // ── 2. Fallback genérico (por si Binance cambia data-bn-type) ──
            for (const span of document.querySelectorAll('span')) {
                const texto = normalizarEspacios(span.textContent);
                if (texto.includes('pagado') && !texto.includes('cancelar')) {
                    const btn = span.closest('button');
                    if (btn && !btn.disabled) return btn;
                }
            }
            for (const btn of document.querySelectorAll('button')) {
                const texto = normalizarEspacios(btn.textContent);
                if (texto.includes('pagado') && !texto.includes('cancelar') && !btn.disabled) {
                    return btn;
                }
            }
            return null;
        }

        /* ============================================
           ★ V4.7: ENVÍO AUTOMÁTICO DEL RECIBO AL CHAT
           1) La imagen se toma de GM storage (la deja ahí Banesco), así no
              depende del portapapeles ni de que esta pestaña tenga el foco.
              Si no está, se intenta el portapapeles como respaldo.
           2) Se pega en el chat (aparece la miniatura con la ✕).
           3) Se simula Enter; si la miniatura no desaparece, se hace clic
              en el botón de enviar como respaldo.
        ============================================ */
        const esperar = (ms) => new Promise(r => setTimeout(r, ms));
        const IMG_TTL_MS = 10 * 60 * 1000;

        /* ── Panel de diagnóstico en pantalla (clic para cerrar, Alt+D para verlo) ── */
        const diagLines = [];
        function describir(el) {
            if (!el) return '(null)';
            let d = el.tagName.toLowerCase();
            if (el.id) d += '#' + el.id;
            if (el.className && typeof el.className === 'string') d += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
            if (el.placeholder) d += ' [ph="' + el.placeholder + '"]';
            if (el.accept) d += ' [accept="' + el.accept + '"]';
            return d;
        }
        function renderDiag() {
            let p = document.getElementById('p2p-diag');
            if (!p) {
                p = document.createElement('div');
                p.id = 'p2p-diag';
                p.style.cssText = 'position:fixed;bottom:90px;left:20px;z-index:999999;background:rgba(0,0,0,.88);' +
                    'color:#7CFC00;font:12px/1.4 monospace;padding:8px 10px;border-radius:8px;max-width:520px;' +
                    'max-height:340px;overflow:auto;white-space:pre-wrap;cursor:pointer;';
                p.onclick = () => p.remove();
                document.body.appendChild(p);
            }
            p.textContent = 'P2P diagnóstico (clic para cerrar)\n' + diagLines.join('\n');
            p.scrollTop = p.scrollHeight;
        }
        function diag(msg) {
            console.log('[P2P-DIAG]', msg);
            diagLines.push(new Date().toLocaleTimeString() + '  ' + msg);
            if (diagLines.length > 40) diagLines.shift();
            renderDiag();
        }

        function buscarTextareaChat() {
            const tas = [...document.querySelectorAll('textarea')];
            return tas.find(t => /mensaje|message/i.test(t.placeholder || '')) ||
                   (tas.length === 1 ? tas[0] : null);
        }

        // Convierte dataURL → Blob SIN fetch() (la CSP de Binance puede bloquear data:)
        function dataUrlABlob(dataUrl) {
            const [cab, b64] = dataUrl.split(',');
            const mime = (cab.match(/data:([^;]+)/) || [])[1] || 'image/png';
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return new Blob([arr], { type: mime });
        }

        async function obtenerBlobRecibo() {
            try {
                const raw = GM_getValue('p2p_recibo_img', '');
                if (!raw) {
                    diag('Storage: no hay imagen guardada por Banesco');
                } else {
                    const { ts, dataUrl } = JSON.parse(raw);
                    const edad = Math.round((Date.now() - ts) / 1000);
                    if (dataUrl && Date.now() - ts < IMG_TTL_MS) {
                        const blob = dataUrlABlob(dataUrl);
                        diag(`Storage: imagen OK (${Math.round(blob.size / 1024)} KB, hace ${edad}s)`);
                        return blob;
                    }
                    diag(`Storage: imagen vencida (hace ${edad}s)`);
                }
            } catch (e) {
                diag('Storage: error leyendo imagen → ' + e.message);
            }
            try {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                    if (item.types.includes('image/png')) {
                        diag('Portapapeles: imagen OK');
                        return await item.getType('image/png');
                    }
                }
                diag('Portapapeles: no contiene imagen');
            } catch (e) {
                diag('Portapapeles: bloqueado → ' + e.message);
            }
            return null;
        }

        /* ── Estructura real del chat de Binance (según el HTML de una orden) ──
           • Input de subida nativo:  input#chat_upload_with_file  ("+" → Subir)
           • Caja del mensaje:        textarea.bn-textarea-input dentro de un
                                      div.bg-ChatInput (rounded-[25px])
           • Mensajes del historial:  div.bChat_chatroom_chatBubble
           • NO hay botón de enviar: el icono a la derecha es el de emojis.
             Se envía solo con Enter. */
        function cajaComposer(ta) {
            const caja = ta.closest('.bg-ChatInput');
            return (caja && caja.parentElement) || ta.parentElement?.parentElement?.parentElement || ta;
        }
        function imgsEnComposer(ta) {
            return [...cajaComposer(ta).querySelectorAll('img, video, canvas, [style*="blob:"]')];
        }
        function burbujas() { return [...document.querySelectorAll('.bChat_chatroom_chatBubble')]; }
        function burbujaNuevaConImagen(previas) {
            return burbujas().find(b => !previas.has(b) && b.querySelector('img, [data-chat-copy-target="image"], [class*="image"], [class*="Image"]')) || null;
        }

        // Espera hasta ms a que pase algo: 'enviado' (burbuja nueva con imagen)
        // o 'preview' (miniatura en la caja del mensaje).
        async function esperarResultado(ta, burbujasPrevias, ms = 4000) {
            for (let t = 0; t < ms; t += 200) {
                if (burbujaNuevaConImagen(burbujasPrevias)) return 'enviado';
                const taAct = buscarTextareaChat() || ta;
                if (imgsEnComposer(taAct).length) return 'preview';
                await esperar(200);
            }
            return null;
        }

        function crearDT(file) { const dt = new DataTransfer(); dt.items.add(file); return dt; }

        const metodosAdjuntar = [
            {
                nombre: 'input #chat_upload_with_file (Subir)',
                fn: (file) => {
                    const inp = document.getElementById('chat_upload_with_file') ||
                                document.querySelector('input[type="file"][accept*="png"]');
                    if (!inp) return false;
                    diag('  usando ' + describir(inp));
                    inp.value = '';
                    inp.files = crearDT(file).files;
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                },
            },
            {
                nombre: 'pegar (paste) en el textarea',
                fn: (file, ta) => {
                    ta.focus();
                    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: crearDT(file), bubbles: true, cancelable: true }));
                },
            },
        ];

        function eventoTecla(tipo) {
            const ev = new KeyboardEvent(tipo, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true });
            // Chrome ignora keyCode/which en el constructor → los forzamos
            for (const [k, v] of [['keyCode', 13], ['which', 13], ['charCode', tipo === 'keypress' ? 13 : 0]]) {
                try { Object.defineProperty(ev, k, { get: () => v }); } catch (_) {}
            }
            return ev;
        }
        function simularEnter(el) {
            el.focus();
            el.dispatchEvent(eventoTecla('keydown'));
            el.dispatchEvent(eventoTecla('keypress'));
            el.dispatchEvent(eventoTecla('keyup'));
        }

        let envioEnCurso = false;
        async function enviarReciboAlChat(origen = 'auto') {
            if (envioEnCurso) { diag('Envío ya en curso — ignorado'); return; }
            envioEnCurso = true;
            diagLines.length = 0;
            diag(`=== Enviar recibo al chat (${origen}) — foco pestaña: ${document.hasFocus()} ===`);
            try {
                let ta = null;
                for (let i = 0; i < 40 && !ta; i++) {
                    ta = buscarTextareaChat();
                    if (!ta) await esperar(250);
                }
                if (!ta) {
                    const n = document.querySelectorAll('textarea').length, f = document.querySelectorAll('iframe').length;
                    diag(`❌ Textarea del chat no encontrado (textareas: ${n}, iframes: ${f})`);
                    mostrarNotif('⚠️ No se encontró el chat de la orden', '#7a5a00');
                    return;
                }
                diag('Textarea: ' + describir(ta) + ' | burbujas en chat: ' + burbujas().length);

                const blob = await obtenerBlobRecibo();
                if (!blob) {
                    diag('❌ Sin imagen para enviar');
                    mostrarNotif('⚠️ No hay imagen del recibo para enviar', '#7a5a00');
                    return;
                }
                const file = new File([blob], 'recibo.png', { type: 'image/png', lastModified: Date.now() });

                const burbujasPrevias = new Set(burbujas());
                let resultado = null;

                // 1) Adjuntar
                for (const m of metodosAdjuntar) {
                    try {
                        if (m.fn(file, ta) === false) { diag(`Adjuntar por ${m.nombre}: no encontrado`); continue; }
                    } catch (e) {
                        diag(`Adjuntar por ${m.nombre}: error → ${e.message}`);
                        continue;
                    }
                    resultado = await esperarResultado(ta, burbujasPrevias);
                    diag(`Adjuntar por ${m.nombre}: ${resultado === 'enviado' ? '✅ enviado directo' : resultado === 'preview' ? '✅ miniatura lista' : '✗ sin cambios'}`);
                    if (resultado) break;
                }

                // 2) Si quedó como miniatura → Enter (hasta 3 intentos)
                for (let i = 1; resultado === 'preview' && i <= 3; i++) {
                    await esperar(600);
                    ta = buscarTextareaChat() || ta;
                    simularEnter(ta);
                    diag(`Enter #${i} simulado`);
                    for (let t = 0; t < 2500; t += 250) {
                        await esperar(250);
                        if (burbujaNuevaConImagen(burbujasPrevias) || !imgsEnComposer(buscarTextareaChat() || ta).length) {
                            resultado = 'enviado';
                            break;
                        }
                    }
                }

                if (resultado === 'enviado') {
                    GM_setValue('p2p_recibo_img', '');
                    diag('✅ Recibo enviado al chat');
                    mostrarNotif('📤 Recibo enviado al chat');
                    setTimeout(() => document.getElementById('p2p-diag')?.remove(), 8000);
                } else if (resultado === 'preview') {
                    diag('❌ Miniatura lista pero Enter simulado no la envió');
                    mostrarNotif('⚠️ Recibo listo en el chat — pulsa Enter', '#7a5a00');
                } else {
                    diag('❌ Ningún método logró adjuntar la imagen. Composer: ' + cajaComposer(ta).innerHTML.slice(0, 200));
                    mostrarNotif('⚠️ No se pudo adjuntar el recibo — Alt+E para reintentar', '#7a5a00');
                }
            } catch (e) {
                diag('❌ Error inesperado: ' + e.message);
                mostrarNotif('⚠️ No se pudo enviar el recibo: ' + e.message, '#7a5a00');
            } finally {
                envioEnCurso = false;
            }
        }

        // Alt+E: reintentar envío | Alt+D: mostrar panel de diagnóstico
        document.addEventListener('keydown', (e) => {
            if (!e.altKey) return;
            const k = e.key.toLowerCase();
            if (k === 'e') { e.preventDefault(); enviarReciboAlChat('Alt+E'); }
            if (k === 'd') { e.preventDefault(); renderDiag(); }
        });

        function marcarComoPagadoConReintentos(intentos = 15, intervaloMs = 100) {
            let i = 0;
            const timer = setInterval(() => {
                i++;
                const btn = buscarBotonPagar();
                if (btn) {
                    clearInterval(timer);
                    btn.click();
                    mostrarNotif('✅ ¡Orden marcada como pagada!');
                    console.log('[Binance] ✅ Clic en "Marcar como pagado"');
                    GM_setValue('p2p_pago_exitoso', '');
                    // ★ Enviar recibo al chat tras breve espera
                    setTimeout(() => enviarReciboAlChat('tras marcar pagado'), 2000);
                } else if (i >= intentos) {
                    clearInterval(timer);
                    console.warn('[Binance] ❌ Botón "Marcar como pagado" no encontrado tras', intentos, 'intentos.');
                    mostrarNotif('⚠️ No se encontró el botón "Marcar como pagado". Hazlo manualmente (Alt+M o clic).', '#7a1a1a');
                    GM_setValue('p2p_pago_exitoso', '');
                } else {
                    console.log(`[Binance] Intento ${i}/${intentos} buscando botón…`);
                }
            }, intervaloMs);
        }

        /* ── Manejo unificado de la señal proveniente de Banesco ──────────
           Se dispara desde DOS vías independientes para máxima confiabilidad:
             1) GM_addValueChangeListener → evento inmediato entre pestañas
                (mecanismo nativo de Tampermonkey/Violentmonkey para esto).
             2) setInterval con GM_getValue → respaldo por si el evento no
                llega (algunos gestores de userscripts lo limitan en ciertos
                contextos, ej. pestañas en segundo plano). */
        let ultimaSenal = '';

        function procesarSenal(val, origen) {
            if (!val || val === ultimaSenal) return;
            ultimaSenal = val;
            console.log(`[Binance] 🔔 Señal detectada vía ${origen}:`, val);
            mostrarNotif('🔔 Recibo exitoso — buscando botón de pago…', '#1a4a7a');
            marcarComoPagadoConReintentos();
        }

        // Vía 1: listener nativo (event-driven, dispara casi al instante)
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener('p2p_pago_exitoso', (_key, _oldVal, newVal) => {
                procesarSenal(newVal, 'listener');
            });
            console.log('[Binance] GM_addValueChangeListener registrado');
        } else {
            console.warn('[Binance] GM_addValueChangeListener no disponible — dependiendo solo de polling');
        }

        // Vía 2: polling de respaldo cada 200ms
        setInterval(async () => {
            const val = await GM_getValue('p2p_pago_exitoso', '');
            procesarSenal(val, 'polling');
        }, 200);

        // Heartbeat cada 5s — confirma que el script sigue vivo y qué valor
        // ve en storage, útil para diagnosticar si la señal nunca llega.
        setInterval(async () => {
            const val = await GM_getValue('p2p_pago_exitoso', '');
            console.log('[Binance] ♥ heartbeat — valor actual en storage:', val || '(vacío)');
        }, 5000);

        // Alt+M para marcar manualmente
        document.addEventListener('keydown', (e) => {
            if (e.altKey && e.key.toLowerCase() === 'm') {
                e.preventDefault();
                console.log('[Binance] Alt+M — marcando manualmente');
                marcarComoPagadoConReintentos();
            }
        });

        console.log('[Binance] Listo — listener + polling activos | Alt+M para marcar manualmente');
    }

})();
