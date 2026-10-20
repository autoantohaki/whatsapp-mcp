/** A small self-refreshing page that shows the WhatsApp QR code in the browser. */
export function pairingPage(token: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar WhatsApp</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f6f5; --card: #fff; --text: #1d2521; --muted: #5d6a63; --ok: #128c4b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111614; --card: #1b221f; --text: #e8eeeb; --muted: #9aa8a1; --ok: #3ccf7f; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { background: var(--card); border-radius: 16px; padding: 32px; max-width: 460px; width: calc(100% - 32px);
         box-sizing: border-box; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p, li { color: var(--muted); }
  ol { text-align: left; padding-left: 22px; }
  #qr { background: #fff; border-radius: 12px; padding: 8px; margin: 16px auto; width: 300px; max-width: 100%; min-height: 300px;
        display: grid; place-items: center; color: #5d6a63; }
  #qr img { width: 100%; }
  .ok { color: var(--ok); font-size: 20px; font-weight: 600; }
  .en { font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Conectar o WhatsApp</h1>
  <div id="body"><p>Carregando…</p></div>
  <p class="en">Open WhatsApp on your phone → Linked devices → Link a device, then scan the code.</p>
</main>
<script>
  const token = ${JSON.stringify(token)};
  const body = document.getElementById("body");
  let lastQr = "";
  async function refresh() {
    try {
      const state = await (await fetch("/pair/state?token=" + token)).json();
      if (state.state === "ready") {
        const who = state.linkedAccount ? " (" + (state.linkedAccount.name || "") + " " + state.linkedAccount.number + ")" : "";
        body.innerHTML = '<p class="ok">✓ WhatsApp conectado' + who + '</p><p>Pode fechar esta janela e voltar ao Claude.</p>';
        lastQr = "";
      } else if (state.qr) {
        if (state.qr !== lastQr) {
          lastQr = state.qr;
          body.innerHTML = '<ol><li>Abra o WhatsApp no celular.</li><li>Toque em <b>Dispositivos conectados</b> → <b>Conectar um dispositivo</b>.</li><li>Aponte a câmera para o código abaixo.</li></ol>' +
            '<div id="qr"><img alt="Código QR do WhatsApp" src="/pair/qr.svg?token=' + token + '&t=' + Date.now() + '"></div>';
        }
      } else {
        lastQr = "";
        body.innerHTML = '<div id="qr">Preparando o WhatsApp… (' + state.state + ')</div>';
      }
    } catch {
      body.innerHTML = "<p>O serviço do WhatsApp não está respondendo. Volte ao Claude e peça para verificar o WhatsApp.</p>";
    }
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
