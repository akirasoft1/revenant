.PHONY: protoc test

protoc:
	python3 -m grpc_tools.protoc -I proto \
	  --python_out=src --grpc_python_out=src proto/voice.proto

test:
	pytest -v
