import {formatReferenceValue} from '../dashboard-reference-model.js';
// Presentation only: the bridge supplies authorized labels and capabilities.
// No permission inference, network request, or separate application state.
export function ReferenceTables({ tables = [], canCreate = false, onCreate, onOpen }) {
  return <section aria-label="Reference tables">
    <h2>Reference tables</h2>
    {canCreate && <button type="button" onClick={onCreate}>Add reference table</button>}
    {tables.length === 0 ? <p>No reference tables yet.</p> : <ul>{tables.map((table) =>
      <li key={table.key}><button type="button" onClick={() => onOpen?.(table.key)}>{table.name}</button>
        <span>{table.published ? "Published" : "Draft"}</span></li>)}</ul>}
  </section>;
}

export function ReferenceValues({ title, columns = [], rows = [], canEdit = false, onChange }) {
  return <section aria-label={title}><h3>{title}</h3>
    <div style={{ overflowX: "auto", maxWidth: "100%" }} tabIndex={0} role="region" aria-label="Reference values">
      <table><thead><tr><th scope="col">Position</th>{columns.map((column) =>
        <th key={column.key} scope="col">{column.name}{column.unit ? ` (${column.unit})` : ""}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key}><th scope="row">{row.name}</th>{columns.map((column) =>
          <td key={column.key}>{column.values.map((kind) => {
            const value = row.cells?.[column.key]?.[kind.key];
            return <div key={kind.key}>{canEdit ? <label>{kind.name}<input type="number" step="any"
              style={{ fontSize: 16, minHeight: 44 }} value={value ?? ""}
              onChange={(event) => onChange?.({ rowKey: row.key, columnKey: column.key, valueKey: kind.key,
                value: event.target.value === "" ? null : Number(event.target.value) })} /></label>
              : <span>{kind.name}: {value===undefined||value===null?"Not available":formatReferenceValue(value)}</span>}</div>;
          })}</td>)}</tr>)}</tbody></table>
    </div>
  </section>;
}
