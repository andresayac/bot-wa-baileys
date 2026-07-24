# @bot-wa/campaigns

Planificador de campañas con consentimiento, segmentación por tags y deduplicación por tenant/campaña/destinatario.

`CampaignPlanner.plan()` devuelve envíos `queued` y descartes explicables (`opt_out`, `segment`, `duplicate`). Un worker durable debe consumir los `queued` y registrar los resultados reales de envío.
