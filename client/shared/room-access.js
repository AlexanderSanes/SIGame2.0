export async function roomJoinUrl(roomId) {
  const code = encodeURIComponent(roomId);
  try {
    const response = await fetch(`/api/rooms/${code}`);
    if (response.ok) {
      const { joinUrl } = await response.json();
      if (joinUrl) return joinUrl;
    }
  } catch { /* Используем адрес текущей страницы. */ }
  return `${location.origin}/player/?room=${code}`;
}

export async function loadJoinQr(image, joinUrl) {
  const response = await fetch(`/api/qr?text=${encodeURIComponent(joinUrl)}`);
  if (!response.ok) throw new Error('Не удалось сгенерировать QR-код');
  const { dataUrl } = await response.json();
  if (!dataUrl) throw new Error('Не удалось сгенерировать QR-код');
  image.src = dataUrl;
  image.hidden = false;
}
