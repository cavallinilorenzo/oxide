# Oxide — revisione dell’interfaccia desktop

Metodo: due valutazioni indipendenti, A (design) e B (detector, contrasto e browser). Target: `web/src/App.tsx`, componenti condivisi, composer e Settings. Modalità **Operate**. Baseline: `ffc1e17`; revisione del 26 ottobre 2026.

L’interfaccia ha un’identità appropriata: superfici scure, Octicons, gerarchia Project → Thread e azioni Git vicine al lavoro. La densità è utile, ma nella baseline i pannelli sottraevano spazio al compito principale e alcuni dettagli operativi avevano contrasto insufficiente. I fix preservano struttura, contenuti e linguaggio visivo.

## Selezione dei Project nella palette

Il clic sulle righe non eseguiva alcuna azione: la palette era collegata soltanto a Enter, pur mostrando cursore e stato hover da controllo cliccabile. La correzione collega ogni riga al proprio Project, azione o repository GitHub, condividendo lo stesso percorso con la tastiera. Il puntatore aggiorna la selezione senza togliere il focus da Search; la navigazione mantiene visibile la riga attiva e ne espone l’identità tramite `aria-activedescendant`. Gli indici restano validi quando i risultati asincroni si riducono.

Il test di regressione clicca sul secondo Project mentre il primo è evidenziato: prima della correzione registrava zero chiamate, dopo avvia il Thread nel Project cliccato. Otto test mirati coprono anche tastiera, hover/focus, azioni di aggiunta/clonazione, scelta del repository GitHub e riduzione dei risultati. Lo script `web/scripts/palette-review.mjs` verifica nell’App reale con IPC simulato il passaggio a un altro Project, la creazione nel Project corrente e il percorso da tastiera: tre selezioni, tre Thread creati, zero errori JavaScript in Chromium e WebKit.

Evidenze: [riga selezionata](palette/palette-selection.png), [Project aperto dopo il clic](palette/selected-project.png), [Chromium](palette/verification-chromium.json), [WebKit](palette/verification-webkit.json). Le fixture non registrano o clonano repository reali.

Verifica complessiva dopo l’integrazione con `main`: **164 test frontend e 220 test Rust** passati, 3 live smoke test ignorati; build, typecheck, lint, formattazione e Clippy riusciti. Bindings invariati rispetto a `main`; resta il warning frontend preesistente su `useVirtualizer`.

Integrato `origin/main` con i nuovi comandi slash: il conflitto in `styles.css` è risolto conservando sia il menu slash sia padding e focus del composer. La verifica browser conferma anche apertura e selezione da tastiera del menu slash dopo l’integrazione. Per riprodurre: `node web/scripts/palette-review.mjs /tmp/oxide-palette` con il server e il modulo Playwright configurati come sotto.

## Zone ridimensionabili

Trascinare i bordi tra le zone per distribuire lo spazio. Il bordo esistente rimane sottile a riposo; hover, focus e trascinamento lo evidenziano in blu, con un’area di presa da 8 px che non aggiunge gutter al layout.

| Zona | Bordo da trascinare | Limiti |
| --- | --- | --- |
| Sidebar Projects/Threads | Bordo destro | 208–400 px |
| Tools | Bordo sinistro | 288–800 px |
| Terminal | Bordo superiore | Da 140 px, fino a 600 px dove c’è spazio |
| Albero Files / anteprima | Divisore interno | Colonne oltre 560 px disponibili, righe sotto questa soglia; dimensioni memorizzate separatamente |

I massimi effettivi dipendono dallo spazio disponibile: il Thread conserva almeno 360 px di larghezza e 280 px di altezza. L’anteprima Files conserva almeno 200 px in larghezza o 120 px in altezza. Nella finestra minima, dimensioni preferite più grandi vengono temporaneamente limitate: tornando a una finestra ampia si ripristinano senza aver sovrascritto le preferenze.

Ogni divisore si raggiunge con Tab:

- Frecce: spostano il divisore di 8 px; Shift + freccia usa passi da 32 px.
- Home / End: raggiungono i limiti disponibili.
- Doppio clic o Enter: ripristinano la dimensione automatica di quella zona.
- Escape durante il trascinamento: annulla la modifica e conserva anche l’eventuale modalità automatica precedente.

Le preferenze vengono conservate localmente sul dispositivo tra aperture dell’app e chiusura/riapertura dei pannelli, condivise tra i Project. Il salvataggio avviene a fine trascinamento o dopo una modifica da tastiera. Dati non validi o memoria locale non disponibile non impediscono il ridimensionamento. I separatori espongono nome, orientamento, valore e limiti alle tecnologie assistive.

Implementazione: `ResizeHandle.tsx` gestisce input e pointer capture con aggiornamenti al massimo una volta per frame; `panelLayout.ts` applica i limiti combinati; `usePanelSize.ts` conserva preferenze e misura i contenitori. Non aggiunge dipendenze né cambia contratti IPC. Le sessioni Terminal restano montate: il ResizeObserver esistente adatta righe e colonne alle nuove dimensioni.

Evidenze: [layout personalizzato con Files a colonne](resize/resized-workspace.png), [layout adattato a 900×560](resize/resized-minimum-window.png), [verifica Chromium](resize/verification-chromium.json), [verifica WebKit](resize/verification-webkit.json).

Verifiche del ridimensionamento: **153 test frontend** passati, typecheck/lint/build riusciti (un warning preesistente su `useVirtualizer`). Chromium e WebKit verificano trascinamento di tutti i divisori, limiti combinati, cambio orientamento Files, tastiera, reset, Escape, pointer cancel, perdita della cattura, blur e rimozione del divisore durante il drag. Verificati anche reload, toggle dei pannelli, Settings, riduzione e ripristino della finestra, dati di layout corrotti e fallimento dello storage. Il mock IPC conferma invii di `resize_terminal` senza nuovi avvii durante i drag; questo non sostituisce il test PTY nativo. Touch drag verificato tramite il protocollo di input di Chromium; hardware touch non provato. Zero errori JavaScript nelle fixture. La suite browser precedente continua a verificare gli stati vuoto/lavoro/approvazione/errore.

Per riprodurre, con lo stesso server Vite e `OXIDE_PLAYWRIGHT_MODULE` descritti sotto:

```sh
node web/scripts/resize-review.mjs /tmp/oxide-resize-chromium
OXIDE_REVIEW_ENGINE=webkit node web/scripts/resize-review.mjs /tmp/oxide-resize-webkit
```

## Polish finale della schermata principale

Il passaggio finale mantiene palette, struttura, contenuti e flussi. Le immagini della prima revisione sotto rimangono disponibili come documentazione dell’audit; queste catture mostrano il risultato aggiornato.

- **Barre allineate:** Thread, Tools e Terminal condividono un’altezza di 40 px. Il nome Terminal è un’etichetta, senza semantica o sottolineatura di un tab selezionabile. Il tab Tools attivo mantiene il suo indicatore anche in hover.
- **Sidebar stabile:** righe Thread da 32 px, gerarchia tra selezione e righe inattive, margini da 8 px. Timestamp e azione Delete condividono lo stesso spazio: il titolo non cambia larghezza in hover. Le azioni contestuali restano visibili e cliccabili quando il focus è nella riga. Settings espone lo stato corrente anche semanticamente.
- **Composer più preciso:** raggio da 12 px, ombra alleggerita e un unico contorno di focus ad alto contrasto sul gruppo; nessun bordo aggiuntivo intorno alla textarea. Rimosso il margine negativo sul transcript. Il selettore nativo dei permessi conserva un target pieno e il focus sul contenitore anche quando mostra soltanto l’icona.
- **Ritmo del transcript:** spaziature 8/16/24 px, bubble con padding 12×16 px, cifre temporali tabulari. Indicazione del Thread vuoto centrata nello spazio disponibile. Percorsi, nomi Thread, branch e selezioni mantengono il valore completo nei titoli nativi pertinenti.
- **Toolbar più uniforme:** segmento Chat/Board compatto, contatori Git monospazio, stati hover/active coerenti del pulsante Commit & Push e separazione leggibile del menu associato.

| Vista finale | Screenshot |
| --- | --- |
| Workspace 1280×800 | [Schermata principale](polish/after-workspace.png) |
| Workspace 900×560 | [Finestra minima](polish/after-workspace-900.png) |
| Composer con focus e invio disponibile | [Focus](polish/after-composer-focus.png) |
| Thread vuoto | [Empty state](polish/after-empty.png) |
| Agente al lavoro | [Working](polish/after-working.png) |
| Richiesta di approvazione | [Approval](polish/after-approval.png) |
| Errore del Provider | [Error](polish/after-error.png) |
| Settings e menu | [Settings](polish/after-settings.png), [dropdown](polish/after-dropdown.png) |

Verifica finale: typecheck, lint, build e 146 test frontend passati; il warning preesistente di React Compiler su `useVirtualizer` rimane invariato. Nessun codice Rust modificato in questo passaggio. Chromium e WebKit verificano 1920×1080, 1280×800, 1024×768 e 900×560, altezza delle barre, focus del composer e del selettore compatto, selezione dei permessi, stabilità della riga in hover, azioni da tastiera e ripristino pannelli. Tutti e quattro gli stati aggiuntivi sono verificati a 1280 e 900 px, inclusa l’assenza di controlli che traboccano dal composer. Zero errori JavaScript nelle fixture.

Metriche: [Chromium](polish/verification-chromium.json), [WebKit](polish/verification-webkit.json). Stati: [Chromium](polish/states-chromium.json), [WebKit](polish/states-webkit.json). Per riprodurre anche le catture degli stati, aggiungere `OXIDE_REVIEW_SCENARIOS=1` ai comandi di verifica descritti sotto. Rimane una sola validazione manuale nativa finale, descritta in fondo al report.

## Criticità, evidenza e correzioni

| Priorità | Criticità della baseline | Correzione implementata |
| --- | --- | --- |
| P1 | A 900×560 la toolbar Git poteva dipingere sopra editor, Finder e Chat. Nomi lunghi peggioravano il problema. | Azioni non comprimibili, area branch comprimibile con ellissi, nome Project limitato; percorso secondario nascosto sotto 1100 px. Tutte le azioni restano accessibili. |
| P1 | Sidebar 256 px + Tools 396 px lasciavano 248 px al Thread e circa 200 px al composer. Terminal occupava 220 px anche al minimo di altezza. | Sidebar 240/208 px, Tools 32vw con limiti 288–600 px, Terminal 25vh con limiti 140–220 px. A 900 px: Thread 404 px e composer 356 px. |
| P1 | Menu Permission mode tagliato dal contenitore Settings: a 900×560 il menu arrivava a y409, ma la vista terminava a y341. | Dropdown in portal su `document.body`, posizionamento nel viewport, apertura sopra/sotto e altezza disponibile limitata. Escape, selezione e ritorno del focus conservati. |
| P1 | `--faint` e bianco sul blu primario non raggiungevano 4,5:1 per testo piccolo. | Token di testo attenuato più leggibili; riempimento primario più scuro, distinto dal blu chiaro di link e focus. |
| P2 | Checkbox senza focus visibile; controlli e placeholder poco distinguibili. | Focus da 2 px anche su input, textarea e summary; bordo specifico per i controlli, diverso dai separatori decorativi. |
| P2 | Paddings e allineamenti irregolari: 7/10/14 px nei controlli, indentazione file 14 px, checkbox allineate alla baseline. | Scala 4/8/12/16 px nei controlli condivisi, gutter principali regolari, indentazione file 16 px, checkbox centrate, azioni compatte con minimo 24 px. |
| P2 | Footer checkout/branch poteva traboccare; etichette lunghe nei dropdown avevano comportamento implicito. | `min-width: 0`, ellissi su valori chiusi e branch, titolo nativo con valore completo; opzioni aperte e descrizioni possono andare a capo. |
| P2 | Hover immediati, disabled ottenuti attenuando l’intero pulsante, salvataggio Settings senza conferma. | Transizioni 120 ms su colori/bordi, stato disabled neutro, preferenza reduced motion rispettata. Save mostra attesa, errore annunciato o conferma; modifiche durante il salvataggio non vengono dichiarate salvate. |

Settings usa ora lo spazio centrale disponibile: Tools viene sospeso e Terminal nascosto durante la modifica. Chiudendo Settings si ripristinano le preferenze dei pannelli; i processi Terminal già aperti rimangono montati. Save e Close restano visibili nel footer sticky. Pulsanti e scorciatoie per i pannelli riportano al workspace con stato coerente.

## Contrasto e palette scura

Rapporti calcolati dalla luminanza relativa dei colori sRGB dichiarati, non stimati dai pixel antialias dello screenshot.

| Coppia | Prima | Dopo |
| --- | ---: | ---: |
| Testo attenuato / background `#0f1115` | 3,19:1 | 6,18:1 |
| Testo attenuato / superficie `#151820` | 3,00:1 | 5,81:1 |
| Testo attenuato / superficie `#1b1f29` | 2,78:1 | 5,39:1 |
| Testo attenuato / superficie `#232836` | 2,48:1 | 4,81:1 |
| Placeholder / composer `#1d2230` | 2,68:1 | 5,19:1 |
| Bianco / pulsante primario | 3,75:1 | 5,15:1 |
| Bianco / hover primario | — | 4,62:1 |
| Bordo controllo / superficie `#1b1f29` | 1,25:1 | 3,59:1 |
| Focus `#58a6ff` / superficie più chiara `#232836` | — | 5,82:1 |

Il vecchio `--dim` era già sufficiente (minimo 4,72:1); viene schiarito per mantenere una gerarchia distinta dal nuovo `--faint`. `--fg` e `--fg-bright` conservano il ruolo primario. Verde, giallo e rosso restano riservati agli stati; il blu alle azioni e selezioni.

Le quattro superfici esistenti rimangono ordinate: background, pannello/card, controllo e selezione/hover. Popup e dialog usano bordo da 1 px e ombra con offset; niente nuove card o elevazioni decorative. I divisori `--line` rimangono sottili: non sono il bordo funzionale di un input. Tooltip e titoli restano quelli nativi; non viene introdotto un sistema di tooltip personalizzato.

Il riferimento è [WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): almeno 4,5:1 per testo normale e 3:1 per testo grande. I controlli inattivi sono esenti dal requisito, pur mantenendo qui un testo leggibile. [WCAG 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) richiede 3:1 per informazioni visive necessarie a riconoscere controlli e stati; non impone questa soglia a ogni divisore decorativo. Questa revisione mirata non certifica la conformità AA dell’intera applicazione.

## Densità, tipografia e allineamento

- UI in font di sistema proporzionale: base 13 px, controlli con line-height 18 px; transcript a 14 px con interlinea più distesa. Nessun font display aggiuntivo.
- Monospazio conservato per codice, log, percorsi e contesto checkout/branch. Contatori Git mantengono cifre tabulari; non serve trasformare tutte le etichette in monospazio.
- Pulsanti condivisi da 28 px, varianti compatte da 24 px, pulsanti icona principali da 32 px. È una scelta desktop per mouse/tastiera; il riferimento AA è [24×24 CSS px con eccezioni](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), non un requisito universale da 44 px.
- Icone Octicons conservate; box flex non comprimibili e allineamento centrale. Differenze di 12/14/16 px hanno un ruolo gerarchico, non vanno uniformate ciecamente a un’unica misura.
- Nomi e identificatori su una riga usano ellissi; descrizioni e avvisi nelle impostazioni usano wrapping. Il contenuto tecnico nel viewer conserva lo scorrimento necessario.
- A Tools stretto rimane il testo del tab attivo; gli altri tab mantengono icona, nome accessibile e titolo nativo. Il composer conserva i nomi accessibili dei selettori quando le etichette secondarie vengono nascoste.

## Regole riutilizzabili

Questi token e pattern sono già disponibili in `web/src/styles.css`:

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --control-height: 28px;
  --control-sm: 24px;
  --control-line: #687690;
  --faint: #8994a9;
  --acc: #1f6ad5;
  --acc2: #58a6ff;
  --motion-fast: 120ms;
}
```

Per un nuovo controllo: usare `.btn`, `.btn.sm`, `.icon-btn` o `.icon-btn.sm`, preservando hover, active, disabled e `:focus-visible`. Per un valore tecnico usare `.mono`; per una riga flessibile usare `.grow`. Il focus generale usa `--acc2` e offset 2 px; righe dentro scrollport usano offset -2 px per evitare clipping. Non animare l’outline: la posizione del focus deve essere immediatamente evidente. Vedi [WCAG Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html).

```tsx
<Dropdown
  label="Default Provider"
  value={provider}
  options={providers}
  onChange={setProvider}
/>
```

Riutilizzare `Dropdown` per selezioni equivalenti: include nome accessibile, frecce, Home/End, Enter/Space, Escape, portal e focus di ritorno. Il menu si chiude quando resize o scroll spostano l’ancora; lo scroll interno delle opzioni rimane disponibile.

Per uniformare il resto dell’app:

1. Distinguere `--line` decorativo da `--control-line` funzionale. Non schiarire tutte le separazioni per risolvere un singolo input.
2. Usare spaziature 4/8 px nei gruppi, 12/16 px tra gruppi; conservare offset ottici, bordi da 1 px e dimensioni delle icone quando motivati.
3. Per flex/grid con nomi variabili, applicare `min-width: 0` al contenitore e al testo; definire esplicitamente ellissi oppure wrapping. Non ridurre mai l’area delle azioni fino alla sovrapposizione.
4. Estendere gli stessi pattern ai menu Git e ai picker senza duplicare nuove palette o motori di posizionamento. Una migrazione più ampia merita un passaggio dedicato.
5. Valutare focus management dei dialog, protezione delle modifiche Settings non salvate e leggibilità con zoom elevato in una revisione comportamentale successiva. Non sono dichiarati risolti da questo lavoro.

## Valutazione euristica iniziale

Valutazione A indipendente, riferita alla baseline; non è un punteggio automatico né una misura prima/dopo.

| Euristica Nielsen | Punteggio /4 | Evidenza iniziale |
| --- | ---: | --- |
| Visibilità dello stato | 3 | Stati Thread chiari; conferma Save assente. |
| Corrispondenza al dominio | 3 | Vocabolario Project/Thread/Git coerente. |
| Controllo dell’utente | 2 | Toggle disponibili; nessuna protezione delle modifiche Settings non salvate. |
| Consistenza | 3 | Palette e controlli coerenti; focus checkbox difforme. |
| Prevenzione errori | 3 | Descrizioni permessi e avvisi Full access. |
| Riconoscimento | 2 | Contesto e label scompaiono alle larghezze ridotte. |
| Efficienza | 3 | Scorciatoie e selezione da tastiera già presenti. |
| Minimalismo | 2 | Pannelli ausiliari dominano il compito principale. |
| Recupero dagli errori | 2 | Ultime impostazioni valide conservate; feedback Save debole. |
| Aiuto | 2 | Titoli e descrizioni presenti, scoperta delle scorciatoie parziale. |
| **Totale** | **25/40** | **Accettabile, con problemi significativi da correggere.** |

Carico cognitivo moderato: tre criticità in focus sul compito, gerarchia e numero di opzioni contemporanee. La struttura per sezioni e le descrizioni dei permessi sono punti da conservare. Per Alex (utente esperto), il problema era la compressione del workspace; per Sam (tastiera/ipovisione), focus e contrasto; per Riley (casi limite), nomi lunghi e menu tagliati. Il percorso passava da un ingresso chiaro a frizione e incertezza dopo Save: i fix intervengono su queste ultime due fasi.

Il detector della valutazione B ha segnalato **1 warning, 0 errori**: `side-tab`, sulla `.rail` del transcript con bordo neutro da 2 px. È un falso positivo rispetto all’accento decorativo laterale: raggruppa chiamate tool e non introduce un nuovo colore di stato. Non viene eliminato per azzerare il conteggio.

Il falso positivo è registrato in `.impeccable/config.json` tramite `hooks ignore-value`: solo la regola `side-tab`, solo per `web/src/styles.css`, con motivazione verificabile. La scansione successiva del file restituisce zero rilievi; gli altri controlli restano attivi.

## Screenshot ed esecuzione

Screenshot del frontend React reale, con fixture IPC Tauri sintetiche. Non sono catture della finestra nativa: nessun Provider eseguito, nessuna impostazione o cartella personale modificata. I confronti a 900 px sono stati catturati in passaggi distinti; il contenuto virtualizzato può avere una diversa posizione di scroll. Il menu prima/dopo documenta soprattutto clipping e posizionamento.

| Vista | Prima | Dopo |
| --- | --- | --- |
| Workspace 1280×800 | [Prima](screenshots/before-workspace.png) | [Dopo](screenshots/after-workspace.png) |
| Workspace 900×560 | [Prima](screenshots/before-workspace-900.png) | [Dopo](screenshots/after-workspace-900.png) |
| Settings 1280×800 | [Prima](screenshots/before-settings.png) | [Dopo](screenshots/after-settings.png) |
| Dropdown 1280×800 | [Prima](screenshots/before-dropdown.png) | [Dopo](screenshots/after-dropdown.png) |
| Dropdown 900×560 | [Prima](screenshots/before-dropdown-900.png) | [Dopo](screenshots/after-dropdown-900.png) |
| Focus checkbox 900×560 | Assente | [Dopo](screenshots/after-checkbox-focus.png) |

Lo script `web/scripts/ui-review.mjs` offre catture e verifiche riproducibili senza aggiungere dipendenze all’app. Fornire un’installazione esterna di Playwright e i suoi browser:

```sh
# Terminale 1, dalla root
pnpm --dir web dev --host 127.0.0.1

# Terminale 2: percorso assoluto a un modulo Playwright installato
export OXIDE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
OXIDE_REVIEW_VERIFY=1 node web/scripts/ui-review.mjs /tmp/oxide-ui-chromium after
OXIDE_REVIEW_ENGINE=webkit OXIDE_REVIEW_VERIFY=1 \
  node web/scripts/ui-review.mjs /tmp/oxide-ui-webkit after
```

Ambiente usato: Playwright 1.64.1, browser Chromium e WebKit inclusi nella sua installazione.

Le catture della baseline richiedono i file `web/src` del commit `ffc1e17`, lo stesso script e l’omissione di `OXIDE_REVIEW_VERIFY` (che verifica le nuove regole). Le fixture non modellano rete, errori dei Provider, processo Terminal o persistenza reale.

Verifiche locali completate:

- `pnpm --dir web typecheck`, `lint`, `test`, `build`: passati, **146 test** in 29 file. Lint conserva un warning preesistente di React Compiler su `useVirtualizer`; zero errori.
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`: passati, **218 test**, 3 live smoke test ignorati per scelta del progetto. Bindings invariati.
- Chromium e WebKit: 1920×1080, 1280×800, 1024×768 e 900×560; nessuna azione header oscurata, nessun overflow orizzontale del documento/footer. Testati anche nomi lunghi, focus checkbox, frecce/End/Enter/Escape, ritorno del focus, menu nel viewport, Save e ripristino pannelli. Zero errori JavaScript nelle fixture. [Metriche Chromium](screenshots/verification-chromium.json), [metriche WebKit](screenshots/verification-webkit.json).
- Detector di sorgente completato; la finestra Tauri macOS/WKWebView non espone CDP. Nessuna scansione pixel della finestra nativa o overlay visibile è dichiarata. Nessun live-server del detector avviato.

## Unica validazione manuale finale di release

Da eseguire insieme sul target attualmente supportato, macOS Apple Silicon: finestra nativa 900×560 e fullscreen, traffic lights e drag della title bar, VoiceOver/Full Keyboard Access sui divisori, zoom e testo lungo reale, dialog e recupero del focus, tooltips nativi, Provider in lavoro/errore/approval, Terminal reale con reflow di righe/colonne durante il resize e ripristino dopo Settings, ripristino delle dimensioni dopo riavvio, salvataggio reale e riapertura delle impostazioni. Confermare anche errori di scrittura e reduced motion a livello di sistema.

PC/Windows: prova nativa rinviata alla disponibilità del supporto Windows; non viene dichiarata verificata da Chromium. iOS: fuori dal target desktop attuale. Nessun controllo manuale intermedio aggiuntivo richiesto. CI non attesa.
