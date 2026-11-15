# GIFs

Provision a Giphy developer API key, save it privately as `GIPHY_API_KEY` in `.env`, and recreate the app with the chosen [hosting command](../SELF-HOSTING.md#apps-and-updates). The server uses the key for Giphy searches and proxies supported media. An unset key leaves GIF search not configured; a nonempty key is not proof it is valid.

```dotenv
GIPHY_API_KEY=
```

Check Settings → Apps, then use the composer GIF picker to search for a harmless test term and send one result into a test channel. Verify that a second client can play it. Observe the provider's usage terms and your key's quota. This W6 pass did not obtain a key or call Giphy; production GIFs remain disabled until the owner supplies one. Encrypted DMs have separate feature restrictions; do not infer channel integration support for them.
