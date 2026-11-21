export const MAC_OS_X_VERSIONS: ReadonlyMap<string, string> = new Map([
  ['cheetah', '10.0'],
  ['puma', '10.1'],
  ['jaguar', '10.2'],
  ['panther', '10.3'],
  ['tiger', '10.4'],
  ['leopard', '10.5'],
  ['snow_leopard', '10.6'],
  ['lion', '10.7'],
]);

export const OS_X_VERSIONS: ReadonlyMap<string, string> = new Map([
  ['mountain_lion', '10.8'],
  ['mavericks', '10.9'],
  ['yosemite', '10.10'],
  ['el_capitan', '10.11'],
]);

export const MACOS_VERSIONS: ReadonlyMap<string, string> = new Map([
  ['sierra', '10.12'],
  ['high_sierra', '10.13'],
  ['mojave', '10.14'],
  ['catalina', '10.15'],
  ['big_sur', '11'],
  ['monterey', '12'],
  ['ventura', '13'],
  ['sonoma', '14'],
  ['sequoia', '15'],
  ['tahoe', '26'],
  ['golden_gate', '27'],
]);

export const MACOS_RELEASE_ORDER: ReadonlyMap<string, number> = new Map(
  [...MAC_OS_X_VERSIONS.keys(), ...OS_X_VERSIONS.keys(), ...MACOS_VERSIONS.keys()].map((tag, index) => [tag, index]),
);
