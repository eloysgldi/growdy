// Só existe para dois trabalhos: receber as notificações e abrir o painel
// quando você toca nelas. Nada de cache — a página é sempre a do servidor,
// para você nunca ficar olhando número velho.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', evento => {
  let aviso = {};
  try { aviso = evento.data ? evento.data.json() : {}; }
  catch (e) { aviso = { titulo: 'Growdy', corpo: evento.data ? evento.data.text() : '' }; }

  evento.waitUntil(self.registration.showNotification(aviso.titulo || 'Growdy', {
    body: aviso.corpo || '',
    icon: '/icone-192.png',
    badge: '/icone-aviso.png',
    tag: aviso.tag || 'growdy',
    renotify: true,
    vibrate: [16, 70, 28],
    data: { url: aviso.url || '/?painel=1' },
  }));
});

self.addEventListener('notificationclick', evento => {
  evento.notification.close();
  const destino = (evento.notification.data && evento.notification.data.url) || '/?painel=1';
  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(janelas => {
      for (const janela of janelas) {
        if ('focus' in janela) {
          if ('navigate' in janela) janela.navigate(destino).catch(() => {});
          return janela.focus();
        }
      }
      return self.clients.openWindow(destino);
    })
  );
});
