# Release Startup Action

Used for:
- Merging the code needed for the release
- Getting the reference to the commit meant for the release
- Generating the release's semantic version information
- Extracting the previous release's version information for the change log generation

Usage:
```yaml
    steps:
      - uses: NoorDigitalAgency/release-startup@main
        id: startup
        name: Release Startup
        with:
          stage: 'alpha' # What stage is the release targeting (alpha, beta and production)
          reference: '' # If the release's source is anything other than the previous stage's latest release
          hotfix: false # If it is a hotfix release (stage must be beta or production)
          token: ${{ secrets.pat }} # Private access token with read and write access to the repository
          exports: true # If true, the outputs will be exported as environment variables
          artifact: true # If true, the outputs will be exported as an artifact
          artifact_name: # The name for the results artifact
      - uses: actions/checkout@v2
        name: Checkout
        with:
          ref: ${{ env.RELEASE_REFERENCE }}
          submodules: 'recursive'
```
