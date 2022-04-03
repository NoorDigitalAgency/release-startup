# Dawn, the multistage release semantic versioning action

Used for:
- Merging the code needed for the release
- Getting the reference to the commit meant for the release
- Generating the release's semantic version information
- Extracting the previous release's version information for the change log generation

Usage:
```yaml
name: Startup
on:
  workflow_call:
    inputs:
      stage:
        description: Stage
        type: string
        required: true
      reference:
        description: Reference
        type: string
        default: ''
      hotfix:
        description: Is a hotfix
        type: boolean
        default: false
    outputs:
      release-version:
        description: The version information generated to be used for the release
        value: ${{ jobs.startup.outputs.version }}
      previous-release-version:
        description: The previous version information used for generating change logs
        value: ${{ jobs.startup.outputs.previous-version }}
jobs:
  startup:
    runs-on: ubuntu-20.04
    name: Startup
    outputs:
      version: ${{ steps.startup.outputs.version }}
      previous-version: ${{ steps.startup.outputs.previous-version }}
    steps:
      - uses: actions/checkout@v2
        name: Initial Checkout
      - uses: NoorDigitalAgency/release-startup@main
        id: startup
        name: Startup
        with:
          stage: ${{ inputs.stage }} # What stage is the release targeting (main for hotfixes)
          reference: ${{ inputs.reference }} # If the release's source is anything other than the previous stage's latest release
          hotfix: ${{ inputs.hotfix }} # If it is a hotfix release or not
          token: ${{ github.token }} # GitHub token for accessing the APIs
      - uses: actions/checkout@v2
        name: Release Checkout
        with:
          ref: ${{ steps.startup.outputs.reference }}
          submodules: 'recursive'

```
