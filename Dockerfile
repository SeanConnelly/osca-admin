# OSCA Portal on InterSystems IRIS for Health Community.
#
# Pinned to 2026.2: the SysAdmin REST API (%Api.Admin) the portal is built on
# first ships in 2026.2, and intersystemsdc/*:latest currently points at 2026.1.
#
# No Node/Vite step: the image installs the prebuilt, committed dist-web/
# (refreshed with `npm run package` before each publish).
ARG IMAGE=intersystemsdc/irishealth-community:2026.2-zpm
FROM $IMAGE

WORKDIR /home/irisowner/dev

# Install the IPM module from the build context, then stop IRIS cleanly so the
# configured state is baked into the image.
RUN --mount=type=bind,src=.,dst=. \
    iris start IRIS && \
    iris session IRIS -U %SYS < iris.script && \
    iris stop IRIS quietly
