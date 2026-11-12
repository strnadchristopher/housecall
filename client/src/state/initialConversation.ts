/** First chat after signing in: the one you last had open, else the server's general chat. */
export function initialConversation(
  channels: { id: string; kind: string }[],
  servers: { general_channel_id: string }[],
  remembered?: string,
): string | undefined {
  const has = (id?: string) => !!id && channels.some(channel => channel.id === id);
  if (has(remembered)) return remembered;
  const general = servers.map(server => server.general_channel_id).find(has);
  return general ?? channels.find(channel => channel.kind === "channel")?.id ?? channels[0]?.id;
}
