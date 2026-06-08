# Browser-native DS9 FITS viewer — static files served by nginx.
FROM nginx:1.27-alpine
COPY . /usr/share/nginx/html/
# allow large FITS uploads via ?file= fetch of bundled samples
RUN sed -i 's/^\(\s*\)location \/ {/\1location \/ {\n\1    client_max_body_size 0;/' /etc/nginx/conf.d/default.conf || true
EXPOSE 80
