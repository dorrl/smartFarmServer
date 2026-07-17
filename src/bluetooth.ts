import noble from '@abandonware/noble';

// gemini 예제 코드
noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    console.log('스캔 시작!');
    await noble.startScanningAsync([], false); // 모든 장치 스캔
  } else {
    console.log(`스캔 종료\n상태: ${state}`);
    await noble.stopScanningAsync();
  }
});

// 장치 발견 시 이벤트
noble.on('discover', async (peripheral) => {
  // 특정 장치 이름이나 ID로 필터링
  console.log(peripheral.advertisement)
  if (peripheral.advertisement.localName === 'MyDevice') {
    console.log(`장치 발견: ${peripheral.address}`);
    await noble.stopScanningAsync();

    // 3. 연결 시도
    await peripheral.connectAsync();
    console.log('연결 성공!');

    // 4. 서비스 및 특성(Characteristic) 검색
    const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
    
    for (const characteristic of characteristics) {
      // 특정 UUID를 가진 특성 찾기
      if (characteristic.uuid === '2a37') { // 예: 심박수 데이터
        // 데이터 읽기
        const data = await characteristic.readAsync();
        console.log('읽은 데이터:', data);

        // 실시간 알림(Notification) 받기
        characteristic.on('data', (data, isNotification) => {
          console.log('수신 데이터:', data.toString('hex'));
        });
        await characteristic.subscribeAsync();
      }
    }
  }
});