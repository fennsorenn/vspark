export interface ComponentTypeDef {
  kind: string
  label: string
  icon: string
  description: string
  /** Node kinds this can be added to. Empty array or ['any'] = unrestricted. */
  applicableTo: string[]
  defaultConfig: Record<string, unknown>
}

export const COMPONENT_TYPES: ComponentTypeDef[] = [
  {
    kind: 'vmc_receiver',
    label: 'VMC Receiver',
    icon: '📡',
    description: 'Receives motion capture data from RhyLive or any VMC-compatible app over UDP.',
    applicableTo: ['any'],
    defaultConfig: {
      host: '0.0.0.0',
      port: 39539,
      blendMode: 'override',
      mirror: false,
    },
  },
]
