.PHONY: install run test docker deploy
install:
	pip install -r requirements-dev.txt
run:
	uvicorn app.main:app --reload --port 8080
test:
	python -m pytest -q
docker:
	docker build -t data-cloud-compass . && docker run --rm -p 8080:8080 data-cloud-compass
deploy:
	./deploy.sh
