// 首版明确支持的常用单位（mathjs 可解析的名称），供输入提示与下拉补全
export interface UnitGroup {
  label: string;
  units: { name: string; hint: string }[];
}

export const UNIT_GROUPS: UnitGroup[] = [
  {
    label: "长度",
    units: [
      { name: "m", hint: "米" },
      { name: "km", hint: "千米" },
      { name: "cm", hint: "厘米" },
      { name: "mm", hint: "毫米" },
      { name: "um", hint: "微米" },
      { name: "in", hint: "英寸" },
      { name: "ft", hint: "英尺" },
      { name: "mi", hint: "英里" },
    ],
  },
  {
    label: "质量",
    units: [
      { name: "kg", hint: "千克" },
      { name: "g", hint: "克" },
      { name: "mg", hint: "毫克" },
      { name: "t", hint: "吨" },
      { name: "lb", hint: "磅" },
      { name: "oz", hint: "盎司" },
    ],
  },
  {
    label: "时间",
    units: [
      { name: "s", hint: "秒" },
      { name: "ms", hint: "毫秒" },
      { name: "min", hint: "分" },
      { name: "h", hint: "时" },
    ],
  },
  {
    label: "温度",
    units: [
      { name: "K", hint: "开尔文" },
      { name: "degC", hint: "摄氏度" },
      { name: "degF", hint: "华氏度" },
    ],
  },
  {
    label: "角度",
    units: [
      { name: "rad", hint: "弧度" },
      { name: "deg", hint: "度" },
      { name: "grad", hint: "梯度" },
    ],
  },
  {
    label: "速度 / 加速度",
    units: [
      { name: "m/s", hint: "米每秒" },
      { name: "km/h", hint: "千米每时" },
      { name: "m/s^2", hint: "米每二次方秒" },
    ],
  },
  {
    label: "力学 / 能量 / 功率",
    units: [
      { name: "N", hint: "牛" },
      { name: "kN", hint: "千牛" },
      { name: "lbf", hint: "磅力" },
      { name: "Pa", hint: "帕" },
      { name: "kPa", hint: "千帕" },
      { name: "MPa", hint: "兆帕" },
      { name: "bar", hint: "巴" },
      { name: "psi", hint: "磅每平方英寸" },
      { name: "J", hint: "焦" },
      { name: "kJ", hint: "千焦" },
      { name: "kWh", hint: "千瓦时" },
      { name: "W", hint: "瓦" },
      { name: "kW", hint: "千瓦" },
    ],
  },
  {
    label: "频率 / 几何 / 电",
    units: [
      { name: "Hz", hint: "赫兹" },
      { name: "kHz", hint: "千赫" },
      { name: "MHz", hint: "兆赫" },
      { name: "m^2", hint: "平方米" },
      { name: "m^3", hint: "立方米" },
      { name: "L", hint: "升" },
      { name: "mL", hint: "毫升" },
      { name: "A", hint: "安培" },
      { name: "mA", hint: "毫安" },
      { name: "V", hint: "伏特" },
      { name: "kV", hint: "千伏" },
      { name: "ohm", hint: "欧姆" },
      { name: "C", hint: "库仑" },
    ],
  },
];

export const ALL_UNITS: { name: string; hint: string }[] =
  UNIT_GROUPS.flatMap((g) => g.units);
