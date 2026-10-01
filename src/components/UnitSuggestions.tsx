import { ALL_UNITS } from "../engine/units";

/** 全局单位自动补全列表（input[list="unit-suggestions"]） */
export default function UnitSuggestions() {
  return (
    <datalist id="unit-suggestions">
      {ALL_UNITS.map((u) => (
        <option key={u.name} value={u.name}>{u.hint}</option>
      ))}
    </datalist>
  );
}
