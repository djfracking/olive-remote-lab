# Olive model compatibility strategy

Olive Remote Lab targets the complete known Olive music-server/player family, but compatibility is recorded per model and firmware rather than inferred from branding.

## Registry

| Generation | Research targets | Current status |
| --- | --- | --- |
| Early | Symphony, Musica, OPUS, OPUS No.3, MELODY | Device captures needed |
| Maestro era | Symphony No.2, OPUS No.4, OPUS No.5, MELODY No.2 | Device captures needed |
| Olive/HD | Olive 2, Olive 4, O2M, O3HD, O4HD, O5HD, O6HD | O4HD verified; others need captures |
| ONE | Olive ONE | Separate platform; device capture needed |

Some names represent regional or marketed variants. The typed registry can preserve aliases while protocol adapters are grouped only after identical behavior is observed.

## Compatibility rule

A model appearing in the registry is not a claim that control works. Each capability has one of three evidence states:

- `verified`: exercised against a physical device with a captured response contract.
- `shared-firmware-marker`: source or markup points to shared code, but the command has not been exercised on that model.
- `unverified`: the feature stays locked until a device is available.

Only known read paths are used for capability work. Write operations are added one at a time after their exact request, response, and failure behavior are captured.

## What to collect from each additional model

1. Exact front-panel model name and firmware version.
2. IP address and whether ports 80 and/or 8163 answer.
3. Redacted endpoint-test and diagnostics exports.
4. HTML/headers from `/`, `/maestro.php`, and `/index.php`.
5. Read-only library navigation, search, and now-playing responses if the Maestro surface exists.
6. Confirmation of server versus network-player role.

Do not export music titles or personal metadata. The diagnostics exporter redacts likely library content, but captures should still be reviewed before sharing.
