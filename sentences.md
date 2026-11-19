# Calculated variables PR 3: every sentence the screen adds or changes

## New variable (Variables > New variable)
- What fills it: **Measured** — "A data source or a coach records its values." / **Calculated by OptiMove** — "OptiMove adds up other variables of the same unit, for example the distance in three power zones."
- Unit hint (calculated): "The unit of every variable it adds up, for example m."
- In place of the day rule and allowed values: "A day's values are added up (Sum). A calculated variable has no allowed values."
- Adds up: "Choose 2 to 10 variables, by name. If one of them has no value in a session, this variable has no value there either (zero is a value; missing is not)."
- Before a unit: "Enter the unit above: the variables of that unit are offered here."
- None fits: "No variable can be added up with this unit and these levels yet."
- Read failed: "The variables to add up could not be read."
- "Cannot be added up (N)", each with its reason:
  - "Calculated itself; a calculated variable adds up ordinary variables only."
  - "It is a highest value, not an amount, so it cannot be added up." (the same shape for the other non-sum day rules)
  - "Not a number."
  - "Enter the unit first."
  - "In km/h, not m."
  - "Not recorded for drill." (or session, or both)
- "OptiMove does not check whether two of them count the same thing (for example zone 3 and "above 25 W/kg"): choose variables that do not overlap."
- Condition (calculated): "Optional: a zone the value is measured in, or an effort the variable counts. Usually none for a calculated variable."
- Below the form: "Calculated for sessions imported after this variable was made. Sessions imported earlier stay without it." · "OptiMove calculates it for a team once every variable it adds up is switched on for that team." · "Athletes do not see calculated variables."
- After create: "After you create it, the name, short name, description, key and Recorded for cannot be changed, and the variable cannot be deleted. It stays calculated. The variables it adds up and its condition can be changed later with a new version."
- Refusals before sending: "Choose at least 2 variables to add up." · "Choose at most 10." · "One of the chosen variables cannot be added up now (see why below). Untick it."
- Server codes in plain words (v77): "A variable stays calculated, or not, from its first version." · "Every chosen variable must have this variable's unit." · "Every chosen variable must be recorded for each level this variable is recorded for." · "One of the chosen variables is calculated itself. Choose ordinary variables." · "One of the chosen variables can no longer be added up here (archived, or not available to this workspace). Choose again." · "A calculated variable adds this one up, so its unit cannot change." · v78's refusals: the server's own sentence (it names the variable) + " Nothing was saved."

## A calculated variable's detail and list
- List row: "m · adds up Power zone 3 distance + Power zone 4 distance + Power zone 5 distance"
- Fact "Calculated": "Adds up Power zone 3 distance + Power zone 4 distance + Power zone 5 distance. Calculated for sessions imported after this variable was made. Sessions imported earlier stay without it."
- Version row: unit · "adds up …" (no bare "None" any more)

## A session's results (Training Load calendar)
- Under the table: "HMLD is calculated by OptiMove from other variables. Calculated for sessions imported after this variable was made. Sessions imported earlier stay without it. An empty cell means the session was imported before it was made, or one of the variables it adds up has no value or is not switched on for this team."
- An empty cell's label: "Not calculated here: the session was imported before this variable was made, or one of the variables it adds up has no value or is not switched on for this team."

## A dashboard widget (KPI, table, chart)
- "HMLD: Calculated for sessions imported after this variable was made. Sessions imported earlier stay without it."

## Source fields
- Subtitle: "The values each data source sends, and whether you can use them yet." (club: + " A platform administrator confirms what they mean.")
- Toggle: "Show technical details" (the proof words — Evidence, Verified, Observed, not proven, Meaning confirmed — only there)
- Row: human name (unit) · "GPEXE: <its own name>" · one state · one next step:
  - "In use for First team, U19 and 1 more" — "Its values come in with each new session."
  - "Ready to use" — "Put it on a variable on a team's board (Data configuration > Map by drag and drop)."
  - "Not available yet" — platform: "Open it to confirm its unit and meaning." / club: "OptiMove confirms it; there is nothing to do here."
- Closed group "Zone sets and threshold events: not available yet (5)": platform — "OptiMove cannot yet choose which zone or threshold to use for these. To use one zone, create its numbered GPEXE field under More values GPEXE sends and confirm it. Events above a threshold cannot be added yet." / club — "… To use one zone, ask OptiMove support to add it as a field of its own. …"
- Human names: Top speed, Total distance, Duration, Brake events, Burst events, Distance in each power zone, Distance in the top power zone, Distance in each speed zone, Accelerations above a threshold, Decelerations above a threshold.
